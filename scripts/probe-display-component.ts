import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resizeVncDisplay } from '../server/vnc-display.ts';
const execute=promisify(execFile),cli='/Users/staff/.mucodesandbox/tools/lima/bin/limactl';
const env={...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},instance='mu-ee85e6f8043b4d02';
const directory=await mkdtemp(path.join(tmpdir(),'mu-display-probe-')),password=randomBytes(6).toString('base64url');
const guest=String.raw`import json,os,pathlib,pwd,subprocess,sys,tempfile,time,shutil
user=pwd.getpwnam('dev');directory=tempfile.mkdtemp(prefix='mu-display-probe-');os.chown(directory,user.pw_uid,user.pw_gid)
server=None
try:
 secret=directory+'/passwd'
 subprocess.run(['x11vnc','-storepasswd',sys.argv[1],secret],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 os.chown(secret,user.pw_uid,user.pw_gid);os.chmod(secret,0o600)
 log=open(directory+'/server.log','wb')
 server=subprocess.Popen(['sudo','-H','-u','dev','--','Xtigervnc',':98','-geometry','1280x800','-depth','24','-dpi','192','-rfbport','15998','-rfbunixpath',directory+'/vnc.sock','-interface','127.0.0.1','-localhost=1','-SecurityTypes','VncAuth','-rfbauth',secret,'-nolisten','tcp','-UseIPv6=0','-AcceptCutText=0','-SendCutText=0','-AlwaysShared=1'],stdout=log,stderr=log)
 for _ in range(100):
  if pathlib.Path(directory+'/vnc.sock').exists():break
  if server.poll() is not None:raise RuntimeError(pathlib.Path(directory+'/server.log').read_text())
  time.sleep(.05)
 print(json.dumps({'socket':directory+'/vnc.sock'}),flush=True)
 sys.stdin.read()
finally:
 if server is not None:
  server.terminate()
  try:server.wait(3)
  except subprocess.TimeoutExpired:server.kill();server.wait()
 shutil.rmtree(directory,ignore_errors=True)
`;
const worker=spawn(cli,['shell',instance,'sudo','python3','-c',guest,password],{env,stdio:['pipe','pipe','pipe']});
let tunnel:ReturnType<typeof spawn>|undefined;
try {
  const ready=await new Promise<string>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Probe startup timeout')),10_000);worker.stdout.on('data',b=>{text+=b;const line=text.split('\n').find(s=>s.startsWith('{'));if(line){clearTimeout(timer);resolve(JSON.parse(line).socket);}});worker.stderr.on('data',b=>{});worker.on('exit',code=>{clearTimeout(timer);reject(Error(`Probe exited ${code}`));});});
  const socket=path.join(directory,'vnc.sock'),config='/Users/staff/.mucodesandbox/lima/mu-ee85e6f8043b4d02/ssh.config';
  tunnel=spawn('/usr/bin/ssh',['-F',config,'-N','-T','-o','ExitOnForwardFailure=yes','-L',`${socket}:127.0.0.1:15998`,`lima-${instance}`],{stdio:'ignore'});
  for(let i=0;i<40;i++){
    try{const value=await resizeVncDisplay(socket,password,2940,1800);console.log(JSON.stringify({passed:true,actual:value}));await writeFile('test-results/display-component-probe.json',JSON.stringify({passed:true,actual:value},null,2));break;}
    catch(e){if(i===39)throw e;await new Promise(r=>setTimeout(r,100));}
  }
}finally{tunnel?.kill('SIGTERM');worker.stdin.end();await new Promise<void>(r=>{if(worker.exitCode!==null)return r();worker.once('exit',()=>r());});await rm(directory,{recursive:true,force:true});}
