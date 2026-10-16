import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';
import type {Environment,Snapshot} from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'});
const cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const match=html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/);
if(!match)throw new Error('Desktop configuration unavailable');
const config=JSON.parse(match[1]);
const headers={Authorization:`Bearer ${config.token}`};
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as Snapshot;
const environment=snapshot.environments.find(e=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be') as Environment|undefined;
if(environment?.state!=='running'||!environment.network.strict||!environment.network.transparent)throw new Error('Existing protected environment unavailable');
if(snapshot.jobs.some(j=>j.environmentId===environment.id&&j.status==='running'))throw new Error('Environment operation in progress');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const query=`import hashlib,json,os,pathlib,shutil,subprocess
home=pathlib.Path('/home/dev'); executable=shutil.which('claude')
if not executable: raise RuntimeError('Claude Code is not installed')
entry=pathlib.Path(executable).resolve(); package=home/'.local/lib/node_modules/@anthropic-ai/claude-code/package.json'
metadata=json.loads(package.read_text()); native=package.parent/'bin/claude.exe'
digest=hashlib.file_digest(native.open('rb'),'sha256').hexdigest()
settings=[home/'.claude/settings.json',home/'.claude/settings.local.json',pathlib.Path('/workspace/.claude/settings.json'),pathlib.Path('/workspace/.claude/settings.local.json'),pathlib.Path('/etc/claude-code/managed-settings.json')]
rows=[]
for file in settings:
 row={'scope':'managed' if str(file).startswith('/etc/') else 'workspace' if str(file).startswith('/workspace/') else 'user','name':file.name,'exists':file.is_file()}
 if row['exists']:
  try:
   value=json.loads(file.read_text()); hooks=value.get('hooks',{})
   row.update(validJson=True,disableAllHooks=value.get('disableAllHooks') is True,hookEventCount=len(hooks) if isinstance(hooks,dict) else 0,mcpServerCount=len(value.get('mcpServers',{})) if isinstance(value.get('mcpServers',{}),dict) else 0)
  except Exception: row['validJson']=False
 rows.append(row)
mcp=[]
for file in [home/'.mcp.json',pathlib.Path('/workspace/.mcp.json'),home/'.claude.json']:
 row={'scope':'workspace' if str(file).startswith('/workspace/') else 'user','name':file.name,'exists':file.is_file()}
 if row['exists']:
  try:
   value=json.loads(file.read_text()); servers=value.get('mcpServers',{})
   projects=value.get('projects',{})
   row.update(validJson=True,topLevelServerCount=len(servers) if isinstance(servers,dict) else 0,projectServerCount=sum(len(p.get('mcpServers',{})) for p in projects.values() if isinstance(p,dict) and isinstance(p.get('mcpServers',{}),dict)) if isinstance(projects,dict) else 0)
  except Exception: row['validJson']=False
 mcp.append(row)
flags=['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING','DISABLE_AUTOUPDATER']
host_keys=['SSH_CONNECTION','SSH_CLIENT','SSH_TTY','LIMA_INSTANCE','LIMA_HOME','MU_SESSION_TOKEN','LD_PRELOAD','DYLD_INSERT_LIBRARIES']
result={'uid':os.getuid(),'entry':str(entry),'version':metadata['version'],'nativeBytes':native.stat().st_size,'nativeSHA256':digest,'nativeMagic':native.open('rb').read(4).hex(),'privacyFlags':{key:os.environ.get(key) for key in flags},'hostEnvironmentKeysPresent':[key for key in host_keys if key in os.environ],'identity':{key:os.environ.get(key) for key in ['LANG','LC_ALL','TZ']},'settings':rows,'mcpConfiguration':mcp,'credentialFileExists':(home/'.claude/.credentials.json').exists(),'proxyVariables':{key:bool(os.environ.get(key)) for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']}}
print(json.dumps(result))`;
const current=JSON.parse(await runtime.guest(environment,['python3','-c',query],{timeoutMs:15_000,maxBytes:8192}));
const receipt=JSON.parse(await readFile(path.join(root,'test-results/client-environment-audit/packages/2.1.296/receipt.json'),'utf8'));
const protection=await(await fetch(`${info.url}/api/environments/${environment.id}/network/protection`,{headers})).json();
const report={checkedAt:new Date().toISOString(),application:snapshot.system.application,environmentId:environment.id,
  scope:'Read-only current installed CLI hash, presence and counts of fixed settings / MCP paths, and whitelisted startup environment. No credentials, identifiers or config values exported; no account login, CLI execution, requests, configuration or profile changes.',
  current,previousAudit:{version:receipt.version,nativeSHA256:receipt.sha256,signatureVerified:receipt.signatureVerified,
    sameNativeFile:current.nativeSHA256===receipt.sha256&&current.version===receipt.version},protection:{integrity:protection.integrity,leaseActive:protection.leaseActive}};
const directory=path.join(root,'test-results/current-cli-audit');await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,`${report.checkedAt.replaceAll(':','-')}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
