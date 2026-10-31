import {z} from 'zod';
import type {Environment} from '../../../shared/types.ts';
import {AppError} from '../../errors.ts';
import {linuxLocales} from '../../network-guard.ts';
import {GUEST_AUDIO_ENV} from '../../guest-audio.ts';
import {WINDOWS_BROWSER_CANDIDATE,windowsBrowserReleaseRoot} from './browser-releases.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {windowsBrowserAdoptionPrelude,windowsBrowserProgramInput} from './browser-adoption.ts';
import {windowsBrowserCommand,windowsDesktopComponentVerification,startWindowsDisplay} from './browser-guest.ts';
import {WINDOWS_BROWSER_TRIAL_PREFERENCES} from './browser-trial-preferences.ts';

const epochSchema=z.string().regex(/^[a-f0-9]{32}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const windowsBrowserTrialReceiptSchema=z.object({version:z.literal(1),epoch:epochSchema,priorVersion:z.literal(WINDOWS_CHROME.version),candidateVersion:z.literal(WINDOWS_BROWSER_CANDIDATE.version),binding:digest,lease:z.object({session:z.uuid(),boot:z.uuid()}).strict()}).strict();
export type WindowsBrowserTrialReceipt=z.infer<typeof windowsBrowserTrialReceiptSchema>;
export function windowsBrowserTrialEpoch(value:string){const result=epochSchema.safeParse(value);if(!result.success)throw new AppError('候选浏览器事务身份无效',400,'BROWSER_TRIAL_EPOCH');return result.data;}
export function windowsBrowserTrialUnit(epoch:string){return 'mucodesandbox-browser-trial-'+windowsBrowserTrialEpoch(epoch)+'.service';}
export function parseWindowsBrowserTrialReceipt(source:string,epoch:string){
 let value:unknown;try{value=JSON.parse(source);}catch{throw new AppError('候选浏览器状态回执无法核对',502,'BROWSER_TRIAL_RECEIPT');}
 const parsed=windowsBrowserTrialReceiptSchema.safeParse(value);if(!parsed.success||parsed.data.epoch!==windowsBrowserTrialEpoch(epoch))throw new AppError('候选浏览器状态回执无法对应本次事务',502,'BROWSER_TRIAL_RECEIPT');return parsed.data;
}

export const WINDOWS_BROWSER_TRIAL_STOP_HELPERS=String.raw`
def trial_unit(epoch):
 if not isinstance(epoch,str) or not re.fullmatch('[a-f0-9]{32}',epoch):raise RuntimeError('Invalid candidate unit identity')
 return 'mucodesandbox-browser-trial-'+epoch+'.service'
def trial_property(unit,name):
 return subprocess.check_output(['/usr/bin/systemctl','show','--property='+name,'--value',unit],text=True,timeout=10).strip()
def trial_stop_unit(epoch):
 unit=trial_unit(epoch);load=trial_property(unit,'LoadState')
 if load=='not-found':return
 if load!='loaded' or trial_property(unit,'Transient')!='yes' or trial_property(unit,'Description')!='MuCodeSandbox Windows candidate trial '+epoch:raise RuntimeError('Unknown candidate service preserved')
 subprocess.run(['/usr/bin/systemctl','stop',unit],check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 state=trial_property(unit,'ActiveState')
 if state not in ['inactive','failed','']:raise RuntimeError('Candidate service stop not confirmed')
`;

// Fixed dev exec under the same lock used by begin/recovery/commit. The lock
// is deliberately CLOEXEC and is released only at successful dev exec.
export function windowsBrowserTrialLaunchProgram(environment:Environment,epoch:string){
 epoch=windowsBrowserTrialEpoch(epoch);const locale=linuxLocales[environment.identity.locale];if(typeof locale!=='string')throw new AppError('候选浏览器语言无效',400,'BROWSER_TRIAL_IDENTITY');
 const zone=environment.identity.timezone;try{if(typeof zone!=='string'||!zone||zone.length>100)throw Error('Invalid zone');new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw new AppError('候选浏览器时区无效',400,'BROWSER_TRIAL_IDENTITY');}
 const root=windowsBrowserReleaseRoot(WINDOWS_BROWSER_CANDIDATE.version),env={HOME:'/home/dev',USER:'dev',LOGNAME:'dev',PATH:'/usr/local/bin:/usr/bin:/bin',DISPLAY:':99',XAUTHORITY:'/run/mu-browser/Xauthority',TZ:zone,LANG:locale,LC_ALL:locale,LP_NUM_THREADS:'0',GALLIUM_DRIVER:'llvmpipe',LIBGL_ALWAYS_SOFTWARE:'1',MESA_SHADER_CACHE_DISABLE:'true',CHROME_DEVEL_SANDBOX:root+'/chrome-sandbox',PULSE_SERVER:GUEST_AUDIO_ENV.PULSE_SERVER,PULSE_COOKIE:GUEST_AUDIO_ENV.PULSE_COOKIE,PULSE_SINK:'mu_browser'};
 const source=windowsBrowserAdoptionPrelude()+`
with repair_lock() as install_lock:
 os.set_inheritable(install_lock,False)
 data=adoption_require_trial(${JSON.stringify(epoch)},True,True)
 fd=os.open(PROFILE_PARENT/'browser',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(fd))!=data['profile']:raise RuntimeError('Candidate profile descriptor changed')
  process=subprocess.run(['/usr/bin/python3','-I','-c',${JSON.stringify(WINDOWS_BROWSER_TRIAL_PREFERENCES)},str(fd),str(os.getpid()),*data['profile'],${JSON.stringify(environment.identity.locale)}],user=ACCOUNT.pw_uid,group=ACCOUNT.pw_gid,extra_groups=[],pass_fds=(fd,),env={'HOME':'/home/dev','PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},stdin=subprocess.DEVNULL,capture_output=True,timeout=45)
  if process.returncode!=0 or process.stderr or len(process.stdout)>256 or adoption_json(process.stdout)!={'prepared':True}:raise RuntimeError('Candidate profile preparation failed')
 finally:os.close(fd)
 current=adoption_require_trial(${JSON.stringify(epoch)},False,True)
 if adoption_binding(current)!=adoption_binding(data):raise RuntimeError('Candidate profile authority changed')
 os.umask(0o077);os.setgroups([]);os.setresgid(ACCOUNT.pw_gid,ACCOUNT.pw_gid,ACCOUNT.pw_gid);os.setresuid(ACCOUNT.pw_uid,ACCOUNT.pw_uid,ACCOUNT.pw_uid)
 if os.getresuid()!=(ACCOUNT.pw_uid,)*3 or os.getresgid()!=(ACCOUNT.pw_gid,)*3 or os.getgroups():raise RuntimeError('Candidate privileges did not drop')
 os.chdir('/home/dev')
 os.execve('/usr/bin/dbus-run-session',['/usr/bin/dbus-run-session','--',*${JSON.stringify(windowsBrowserCommand(environment,WINDOWS_BROWSER_CANDIDATE.version))}],${JSON.stringify(env)})
`;
 if(Buffer.byteLength(source)>98304)throw new AppError('候选浏览器启动程序超出边界',500,'BROWSER_TRIAL_SIZE');return source;
}

export function windowsBrowserTrialStatusProgram(epoch:string,accepted=false){
 epoch=windowsBrowserTrialEpoch(epoch);
 return windowsBrowserAdoptionPrelude()+`with repair_lock():
 data=adoption_require_trial(${JSON.stringify(epoch)},${accepted?'True':'False'},${accepted?'False':'True'})
 ${accepted?'adoption_check_stop(data)':''}
 ${accepted?`if adoption_worker('version',PROFILE_PARENT/'browser',None,data)!={'version':CANDIDATE}:raise RuntimeError('Candidate did not open the managed profile')`:''}
 print(json.dumps(adoption_trial_receipt(${JSON.stringify(epoch)}),sort_keys=True))
`;
}
export function windowsBrowserTrialDisplayProgram(environment:Environment,epoch:string,binding:string,password:string){
 epoch=windowsBrowserTrialEpoch(epoch);if(!digest.safeParse(binding).success)throw new AppError('候选显示事务身份无效',400,'BROWSER_TRIAL_BINDING');const script=startWindowsDisplay(password,environment.cpus);
 return windowsBrowserAdoptionPrelude()+`with repair_lock():
 adoption_require_trial(${JSON.stringify(epoch)},False,True)
 receipt=adoption_trial_receipt(${JSON.stringify(epoch)})
 if receipt['binding']!=${JSON.stringify(binding)}:raise RuntimeError('Candidate display belongs to another checkpoint')
 subprocess.run(['/bin/bash','-s'],input=${JSON.stringify(script)}.encode(),check=True,timeout=90,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print(json.dumps(adoption_trial_receipt(${JSON.stringify(epoch)}),sort_keys=True))
`;
}
export function windowsBrowserTrialStartProgram(environment:Environment,epoch:string){
 epoch=windowsBrowserTrialEpoch(epoch);const unit=windowsBrowserTrialUnit(epoch),launch=windowsBrowserTrialLaunchProgram(environment,epoch),root=windowsBrowserReleaseRoot(WINDOWS_BROWSER_CANDIDATE.version),policy=`abi <abi/4.0>,\ninclude <tunables/global>\n${root}/chrome flags=(unconfined) {\n userns,\n}\n`;
 const args=['/usr/bin/systemd-run','--no-ask-password','--quiet','--collect','--expand-environment=no','--service-type=exec','--unit='+unit,'--description=MuCodeSandbox Windows candidate trial '+epoch,'--property=User=root','--property=Group=root','--property=WorkingDirectory=/home/dev','--property=UMask=0077','--property=KillMode=control-group','--property=TimeoutStopSec=15','--property=RuntimeMaxSec=180','--property=Restart=no','--property=BindsTo=mucodesandbox-display.service','--property=After=mucodesandbox-display.service','--property=PartOf=mucodesandbox-display.service','/usr/bin/python3','-I','-c',launch];
 return windowsBrowserAdoptionPrelude()+WINDOWS_BROWSER_TRIAL_STOP_HELPERS+`
with repair_lock():
 adoption_require_trial(${JSON.stringify(epoch)},False,True)
 ${windowsDesktopComponentVerification(WINDOWS_BROWSER_CANDIDATE.version).trim().split('\n').join('\n ')}
 if trial_property(${JSON.stringify(unit)},'LoadState')!='not-found':raise RuntimeError('Candidate service already exists; recover its original transaction')
 subprocess.run(['/usr/bin/systemctl','is-active','--quiet','mucodesandbox-display.service'],check=True,timeout=10)
 subprocess.run(['/usr/sbin/apparmor_parser','-r'],input=${JSON.stringify(policy)}.encode(),check=True,timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
# The new service acquires this same lock. Never wait for it while holding it.
subprocess.run(${JSON.stringify(args)},check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps(adoption_trial_receipt(${JSON.stringify(epoch)}),sort_keys=True))
`;
}
export const windowsBrowserTrialStopSchema=z.object({version:z.literal(1),epoch:epochSchema,browserStopped:z.literal(true),displayStopped:z.literal(true)}).strict();
export function windowsBrowserTrialStopProgram(epoch:string,binding:string){
 epoch=windowsBrowserTrialEpoch(epoch);if(!digest.safeParse(binding).success)throw new AppError('候选浏览器停止身份无效',400,'BROWSER_TRIAL_BINDING');
 return windowsBrowserAdoptionPrelude()+WINDOWS_BROWSER_TRIAL_STOP_HELPERS+`
trial_stop_unit(${JSON.stringify(epoch)})
display_stopped=False
with repair_lock():
 _,data=adoption_load()
 if data['epoch']!=${JSON.stringify(epoch)} or data['phase']!='trial' or adoption_binding(data)!=${JSON.stringify(binding)}:raise RuntimeError('Candidate stop belongs to another transaction')
 with pathlib.Path('/proc/sys/kernel/random/boot_id').open('rb') as source:boot=source.read(65).decode('ascii').strip()
 if boot!=data['lease']['boot']:raise RuntimeError('Candidate stop belongs to an earlier boot')
 adoption_stop_fence(data)
 windows_stop_browser()
 display='mucodesandbox-display.service';load=trial_property(display,'LoadState')
 if load=='not-found':display_stopped=True
 elif load=='loaded' and trial_property(display,'Description')=='MuCodeSandbox Windows guest display':
  subprocess.run(['/usr/bin/systemctl','stop',display],check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);display_stopped=trial_property(display,'ActiveState') in ['inactive','failed']
 if not display_stopped:raise RuntimeError('Candidate display stop not confirmed')
print(json.dumps(dict(version=1,epoch=${JSON.stringify(epoch)},browserStopped=True,displayStopped=display_stopped),sort_keys=True))
`;
}
export function windowsBrowserTrialInput(program:string){return windowsBrowserProgramInput(program);}
