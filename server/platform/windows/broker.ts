import {connect} from 'node:net';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {run,type RunOptions,type Runner} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {powershellPath,powershellArgs,powershellScript,fileHash} from './runtime.ts';

const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../scripts/windows');
const reply=z.discriminatedUnion('ok',[z.object({ok:z.literal(true),result:z.unknown()}).strict(),z.object({ok:z.literal(false),code:z.string(),error:z.string()}).strict()]);
export type BrokerAction='hello'|'doctor'|'fingerprint'|'disk'|'create'|'start'|'stop'|'status'|'inspect'|'channel'|'close-channel'|'shutdown'|'allocation'|'recover'|'prepare'|'delete'|'absence'|'begin-base'|'seal-base'|'base-status'|'discard-base-builder'|'host-status'|'prepare-host';

export class HyperVBrokerClient{
 readonly pipe:string;
 constructor(nonce:string){if(!/^[a-f0-9]{64}$/.test(nonce))throw Error('Invalid broker endpoint');this.pipe='\\\\.\\pipe\\MuCodeSandbox-Broker-'+nonce;}
 call(action:BrokerAction,parameters:Record<string,unknown>={},options:RunOptions={}):Promise<unknown>{
  return new Promise((resolve,reject)=>{
   if(options.signal?.aborted){reject(new AppError('操作已取消',409,'CANCELLED'));return;}
   const payload=JSON.stringify({...parameters,action});if(Buffer.byteLength(payload)>65536){reject(new AppError('权限代理请求过大',400,'BROKER_REQUEST_TOO_LARGE'));return;}
   const socket=connect(this.pipe);let bytes=Buffer.alloc(0),settled=false;
   const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);socket.destroy();if(error)reject(error);else resolve(value);};
   const abort=()=>finish(new AppError('操作已取消',409,'CANCELLED'));
   const timer=setTimeout(()=>finish(new AppError('权限代理未及时完成操作',504,'BROKER_TIMEOUT')),options.timeoutMs??45000);timer.unref();
   options.signal?.addEventListener('abort',abort,{once:true});socket.once('connect',()=>socket.write(payload+'\n'));
   socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>256*1024){finish(Error('Oversized broker reply'));return;}const end=bytes.indexOf(10);if(end<0)return;try{const value=reply.parse(JSON.parse(bytes.subarray(0,end).toString('utf8')));if(value.ok)finish(undefined,value.result);else finish(new AppError(value.error,value.code==='DENIED'?403:409,value.code));}catch(error){finish(error instanceof Error?error:Error('Invalid broker reply'));}});
   socket.once('error',()=>finish(new AppError('Windows 权限代理连接已关闭',503,'BROKER_UNAVAILABLE')));socket.once('close',()=>{if(!settled)finish(new AppError('Windows 权限代理未返回结果',503,'BROKER_UNAVAILABLE'));});
  });
 }
 async hello(){return z.object({version:z.literal(1),ownerPid:z.literal(process.pid),ownerSid:z.string().regex(/^S-1-/),elevated:z.literal(true),protectedStorage:z.literal(true),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await this.call('hello'));}
}

export async function brokerSourceDigest(){
 const files=['../../native/windows/HyperVBroker.cs','../../native/windows/SealedBases.cs','../../native/windows/HostComponents.cs','../../native/windows/HyperVChannel.cs','hyperv.ps1','host-components.ps1','build-broker.ps1','install-broker.ps1'];const sha=createHash('sha256');for(const file of files){sha.update(file+'\0');sha.update(await readFile(path.resolve(scripts,file)));}return sha.digest('hex');
}

export function cleanWindowsEnvironment(){
 const system=process.env.SystemRoot??'C:\\Windows',env:NodeJS.ProcessEnv={SystemRoot:system,WINDIR:system,PATH:path.join(system,'System32'),PSModulePath:path.join(system,'System32/WindowsPowerShell/v1.0/Modules')};
 for(const name of ['SystemDrive','TEMP','TMP','USERPROFILE','LOCALAPPDATA','PROGRAMDATA'])if(process.env[name])env[name]=process.env[name];return env;
}

export async function buildBroker(root:string,runner:Runner=run){
 const directory=path.join(root,'tools','broker-build-'+randomUUID()),sourceDigest=await brokerSourceDigest();await mkdir(directory,{recursive:true});
 const channelTemp=path.join(directory,'channel.exe'),brokerTemp=path.join(directory,'broker.exe');
 try{
  await runner(powershellPath(),powershellArgs(`${powershellScript(path.join(scripts,'build-channel.ps1'))} -ScriptDirectory '${scripts.replaceAll("'","''")}' -Destination '${channelTemp.replaceAll("'","''")}'`),{env:cleanWindowsEnvironment(),timeoutMs:30000});
  const channelSha256=await fileHash(channelTemp),channelFile='hv-channel-'+channelSha256.slice(0,16)+'.exe',channel=path.join(directory,channelFile);await rename(channelTemp,channel);
  await runner(powershellPath(),powershellArgs(`${powershellScript(path.join(scripts,'build-broker.ps1'))} -ScriptDirectory '${scripts.replaceAll("'","''")}' -Destination '${brokerTemp.replaceAll("'","''")}' -ChannelFile '${channelFile}' -SourceDigest '${sourceDigest}'`),{env:cleanWindowsEnvironment(),timeoutMs:30000});
  await runner(brokerTemp,['--self-test'],{timeoutMs:5000});const sha256=await fileHash(brokerTemp),brokerFile='hv-broker-'+sha256.slice(0,16)+'.exe',broker=path.join(directory,brokerFile);await rename(brokerTemp,broker);
  return {directory,broker,brokerFile,sha256,channel,channelFile,channelSha256,sourceDigest};
 }catch(error){const target=path.resolve(directory);if(path.dirname(target)!==path.resolve(root,'tools')||!/^broker-build-[a-f0-9-]{36}$/.test(path.basename(target)))throw Error('Broker staging boundary changed');await rm(target,{recursive:true,force:true});throw error;}
}

export async function installBroker(root:string,runner:Runner=run){
 const artifact=await buildBroker(root,runner),source=await readFile(path.join(scripts,'install-broker.ps1'),'utf8');
 const values={Broker:artifact.broker,ExpectedBrokerHash:artifact.sha256,Channel:artifact.channel,ExpectedChannelHash:artifact.channelSha256,SourceDigest:artifact.sourceDigest};
 const invocation=Object.entries(values).map(([key,value])=>`-${key} '${value.replaceAll("'","''")}'`).join(' ');
 const elevated=`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}')))) ${invocation}`;
 const encoded=Buffer.from(elevated,'utf16le').toString('base64');
 const launch=`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Broker installation did not complete'}`;
 const launcher=path.join(artifact.directory,'install-launch.ps1');await writeFile(launcher,'\ufeff'+launch,{flag:'wx'});
 // Keep the outer command short: the nested elevated payload is already large.
 await runner(powershellPath(),powershellArgs(powershellScript(launcher)),{env:cleanWindowsEnvironment(),timeoutMs:120000});return artifact;
}

export async function hostRuntimeUsable(){
 const result=await run(powershellPath(),powershellArgs("$ErrorActionPreference='Stop';try{$ok=[bool](Get-Module -ListAvailable Hyper-V) -and (Get-Service vmms -ErrorAction Stop).Status -eq 'Running' -and [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent;foreach($name in @('ssh.exe','ssh-keygen.exe')){$ok=$ok -and (Test-Path -LiteralPath (Join-Path $env:SystemRoot ('System32/OpenSSH/'+$name)) -PathType Leaf)};[Console]::Write([bool]$ok)}catch{[Console]::Write($false)}"),{env:cleanWindowsEnvironment(),timeoutMs:20000});return result.trim()==='True';
}
export async function startBroker(executable:string,options:{setupOnly?:boolean;detectHost?:boolean}={}){
 const nonce=randomBytes(32).toString('hex'),client=new HyperVBrokerClient(nonce);
 if(options.setupOnly&&options.detectHost)throw Error('Select one broker startup mode');
 const launch=`$ErrorActionPreference='Stop'; Start-Process -FilePath '${executable.replaceAll("'","''")}' -WorkingDirectory '${path.dirname(executable).replaceAll("'","''")}' -ArgumentList @('--owner','${process.pid}','--pipe','${nonce}'${options.setupOnly?",'--setup-only'":options.detectHost?",'--detect-host'":''}) -Verb RunAs -WindowStyle Hidden`;
 await run(powershellPath(),powershellArgs(launch),{env:cleanWindowsEnvironment(),timeoutMs:30000});
 const expected=await brokerSourceDigest(),until=Date.now()+120000;for(;;){try{const hello=await client.hello();if(hello.sourceDigest!==expected)throw new AppError('权限代理版本与当前源码不一致，请重新安装',409,'BROKER_UPDATE_REQUIRED');return client;}catch(error){if(!(error instanceof AppError)||error.code!=='BROKER_UNAVAILABLE'||Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,200));}}
}

export async function installedBrokerPath(){
 const common=(await run(powershellPath(),powershellArgs("[Console]::Write([Environment]::GetFolderPath('CommonApplicationData'))"),{env:cleanWindowsEnvironment(),timeoutMs:10000})).trim(),bin=path.join(common,'MuCodeSandbox-HyperVBroker-v1','bin');
 const meta=z.object({brokerFile:z.string().regex(/^hv-broker-[a-f0-9]{16}\.exe$/),brokerSha256:z.string().regex(/^[a-f0-9]{64}$/),channelFile:z.string().regex(/^hv-channel-[a-f0-9]{16}\.exe$/),channelSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await readFile(path.join(bin,'current.json'),'utf8')));if(meta.sourceDigest!==await brokerSourceDigest())throw new AppError('权限代理版本与当前源码不一致，请重新安装',409,'BROKER_UPDATE_REQUIRED');
 const file=path.join(bin,meta.brokerFile);if(await fileHash(file)!==meta.brokerSha256)throw Error('Installed broker digest mismatch');return file;
}
