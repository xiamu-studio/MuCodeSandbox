import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';

const root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'});
const cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as any;
const environment=snapshot.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');
if(environment?.state!=='running')throw new Error('The selected existing environment is not running');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const query=`import ctypes,json
x=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(None)
if not d:raise RuntimeError('Cannot inspect display configuration')
x.XGetScreenSaver.argtypes=[ctypes.c_void_p]+[ctypes.POINTER(ctypes.c_int)]*4
values=[ctypes.c_int() for _ in range(4)];x.XGetScreenSaver(d,*[ctypes.byref(v) for v in values])
result=dict(zip(['timeoutSeconds','intervalSeconds','preferBlanking','allowExposures'],[v.value for v in values]))
s=ctypes.CDLL('libXss.so.1')
class Info(ctypes.Structure):_fields_=[('window',ctypes.c_ulong),('state',ctypes.c_int),('kind',ctypes.c_int),('tilOrSince',ctypes.c_ulong),('idle',ctypes.c_ulong),('eventMask',ctypes.c_ulong)]
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
s.XScreenSaverAllocInfo.restype=ctypes.POINTER(Info);i=s.XScreenSaverAllocInfo();s.XScreenSaverQueryInfo.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Info)]
if not s.XScreenSaverQueryInfo(d,x.XDefaultRootWindow(d),i):raise RuntimeError('Screen saver query failed')
result.update(state=i.contents.state,kind=i.contents.kind,idleMs=i.contents.idle,sinceMs=i.contents.tilOrSince)
x.XFree.argtypes=[ctypes.c_void_p];x.XFree(i);x.XCloseDisplay.argtypes=[ctypes.c_void_p];x.XCloseDisplay(d)
print(json.dumps(result))`;
const idle=JSON.parse(await runtime.management(environment,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','python3','-c',query],{timeoutMs:8000,maxBytes:2048}));
const report={at:new Date().toISOString(),version:snapshot.system.version,build:snapshot.system.application,environmentId:environment.id,scope:'Read-only X server idle configuration and state; no pixels, input, profile or network configuration changes',idle};
const directory=path.join(root,'test-results/desktop-idle');await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,`${report.at.replaceAll(':','-')}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
