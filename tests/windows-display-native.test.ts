import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WINDOWS_NATIVE_DISPLAY_INSPECT,parseWindowsNativeDisplay} from '../server/platform/windows/display-native.ts';
import {createWindowsDisplayDriver} from '../server/platform/windows/display-guest.ts';
import {vncChallenge} from '../server/vnc-display.ts';
import type {WindowsPreparedDisplay} from '../server/platform/windows/display-lifecycle.ts';
import type {WindowsBrowserRuntime} from '../server/platform/windows/browser.ts';

const execute=promisify(execFile),measurement={version:1,width:3200,height:2000,dpi:196608,windowScale:2,unscaledDpi:98304};
function rfb(password:string){
 let state=0,pending=Buffer.alloc(0),begun=false,width=1600,height=1000;const lengths=[12,1,16,1,12,10,24,10],challenge=Buffer.alloc(16,17);
 const frame=()=>{const data=Buffer.alloc(36);data.writeUInt16BE(1,2);data.writeUInt16BE(state===8?1:0,4);data.writeUInt16BE(width,8);data.writeUInt16BE(height,10);data.writeInt32BE(-308,12);data[16]=1;data.writeUInt32BE(7,20);data.writeUInt16BE(width,28);data.writeUInt16BE(height,30);return data;};
 return new Duplex({read(){if(!begun){begun=true;this.push(Buffer.from('RFB 003.008\n'));}},write(data,_encoding,done){try{
  pending=Buffer.concat([pending,Buffer.from(data)]);while(state<lengths.length&&pending.length>=lengths[state]){const item=pending.subarray(0,lengths[state]);pending=pending.subarray(lengths[state]);const phase=state++;
   if(phase===0){assert.equal(item.toString(),'RFB 003.008\n');this.push(Buffer.from([1,2]));}
   else if(phase===1){assert.equal(item[0],2);this.push(challenge);}
   else if(phase===2){assert.deepEqual(item,vncChallenge(password,challenge));this.push(Buffer.alloc(4));}
   else if(phase===3){const init=Buffer.alloc(24);init.writeUInt16BE(width,0);init.writeUInt16BE(height,2);init[4]=32;this.push(init);}
   else if(phase===5)this.push(frame());
   else if(phase===6){assert.equal(item[0],251);width=item.readUInt16BE(2);height=item.readUInt16BE(4);}
   else if(phase===7)this.push(frame());
  }done();
 }catch(error){done(error as Error);}}});
}

test('Native receipt distinguishes actual XSETTINGS density from browser screen information',()=>{
 assert.deepEqual(parseWindowsNativeDisplay(JSON.stringify(measurement)),measurement);
 for(const change of [{extra:'private diagnostic'},{width:8192,height:8192},{width:319},{dpi:1},{windowScale:0},{dpi:196608,windowScale:1,unscaledDpi:98304},{dpi:'196608'}]){
  assert.throws(()=>parseWindowsNativeDisplay(JSON.stringify({...measurement,...change})),{code:'DISPLAY_MEASUREMENT_INVALID'});
 }
 for(const raw of ['', 'private invalid json', ' '.repeat(2049)])assert.throws(()=>parseWindowsNativeDisplay(raw),error=>error instanceof Error&&!error.message.includes('private')&&(error as {code?:string}).code==='DISPLAY_MEASUREMENT_INVALID');
});

const wrapper=`import json,subprocess,sys
from unittest.mock import patch
payload=json.loads(sys.argv[1]);calls=[]
def run(command,**options):
 calls.append(command)
 assert options=={'stdin':subprocess.DEVNULL,'stdout':subprocess.PIPE,'stderr':subprocess.DEVNULL,'timeout':3,'check':True}
 key='screen' if command==['/usr/bin/xdpyinfo'] else 'settings'
 if key=='settings':assert command==['/usr/bin/dump_xsettings','--screen=0']
 if payload.get('fail')==key:raise subprocess.CalledProcessError(1,command)
 return subprocess.CompletedProcess(command,0,payload[key].encode('ascii'))
with patch('subprocess.run',run):exec(compile(payload['program'],'native-display-production','exec'),{})
assert calls==[['/usr/bin/xdpyinfo'],['/usr/bin/dump_xsettings','--screen=0']]
`;
const screen='name of display: :99\n  dimensions:    3200x2000 pixels (847x529 millimeters)\n',settings='Xft/DPI 196608\nGdk/WindowScalingFactor 2\nGdk/UnscaledDPI 98304\n';
for(const [name,change,accepted] of [
 ['published settings',{},true],
 ['fractional density',{settings:'Xft/DPI 147456\nGdk/WindowScalingFactor 1\nGdk/UnscaledDPI 147456\n'},true],
 ['stale but valid density',{settings:'Xft/DPI 98304\nGdk/WindowScalingFactor 1\nGdk/UnscaledDPI 98304\n'},true],
 ['missing setting',{settings:'Xft/DPI 196608\n'},false],
 ['duplicate setting',{settings:settings+'Xft/DPI 196608\n'},false],
 ['string instead of integer',{settings:settings.replace('196608','"196608"')},false],
 ['inconsistent settings',{settings:settings.replace('ScalingFactor 2','ScalingFactor 1')},false],
 ['unknown setting',{settings:settings+'Unexpected/Value 2\n'},false],
 ['oversized settings',{settings:'X'.repeat(16385)},false],
 ['failed X11 command',{fail:'screen'},false],
 ['failed published settings command',{fail:'settings'},false],
 ['multiple screen dimensions',{screen:screen+screen},false],
 ['invalid native pixel bounds',{screen:screen.replace('3200x2000','8192x8192')},false],
 ['no native dimensions',{screen:'private diagnostic'},false],
] as const)test('Production native measurement with explicit subprocess adapters: '+name,async()=>{
 const input=JSON.stringify({program:WINDOWS_NATIVE_DISPLAY_INSPECT,screen,settings,...change});
 const task=execute(process.platform==='win32'?'python':'python3',['-I','-c',wrapper,input],{timeout:10000,maxBuffer:8192,windowsHide:true});
 if(!accepted){await assert.rejects(task);return;}
 const {stdout}=await task;assert.equal(parseWindowsNativeDisplay(stdout).width,3200);
});

function fixture(){
 let reads=0,valid=true;const calls:string[][]=[];const entry={environment:{cpus:2},config:{},password:'fixture8',ready:true,closed:false,streams:new Set(),sessionId:'native-display',vnc:()=>rfb('fixture8')} as unknown as WindowsPreparedDisplay;
 const hooks:{read?:()=>string;dpi?:()=>void}={};
 const runtime:WindowsBrowserRuntime={management:async(_config,command)=>{calls.push(command);if(command.at(-1)===WINDOWS_NATIVE_DISPLAY_INSPECT){reads++;return hooks.read?.()??JSON.stringify(measurement);}hooks.dpi?.();return '';},serviceStreamFactory:async()=>()=>rfb('fixture8')};
 const driver=createWindowsDisplayDriver(runtime),options={assertCurrent:()=>{if(!valid)throw Error('Original display retired');}};
 return {driver,entry,calls,hooks,options,reads:()=>reads,invalidate:()=>{valid=false;}};
}
test('Display driver resizes through authenticated RFB and reports measured density without pretending Chrome ran',async()=>{
 const f=fixture(),result=await f.driver.configure!(f.entry,{cssWidth:1600,cssHeight:1000,scaleFactor:2,mode:'fixed'},f.options);
 assert.equal(result.matched,true);assert.equal(result.densitySource,'xsettings');assert.equal(result.nativeScaleFactor,2);assert.equal(result.browserScaleFactor,0);assert.equal(result.screenWidth,undefined);
 assert.equal(f.reads(),1);assert.equal(f.calls.length,2);assert.ok(f.calls.every(command=>command.includes('DISPLAY=:99')&&command.includes('XAUTHORITY=/run/mu-browser/Xauthority')&&command.includes('dev')&&command.includes('-I')));
});
test('Native resize never declares matching density from requested values while published settings stay stale',async()=>{
 const f=fixture();f.hooks.read=()=>JSON.stringify({...measurement,dpi:98304,windowScale:1});
 const result=await f.driver.configure!(f.entry,{cssWidth:1600,cssHeight:1000,scaleFactor:2},f.options);
 assert.equal(result.matched,false);assert.equal(result.nativeScaleFactor,1);assert.equal(result.browserScaleFactor,0);assert.equal(f.reads(),12);
});
test('Native resize waits for published density and refuses an invalid receipt without echoing it',async()=>{
 const f=fixture();f.hooks.read=()=>JSON.stringify({...measurement,dpi:f.reads()<3?98304:196608,windowScale:f.reads()<3?1:2});
 assert.equal((await f.driver.configure!(f.entry,{cssWidth:1600,cssHeight:1000,scaleFactor:2},f.options)).matched,true);assert.equal(f.reads(),3);
 f.hooks.read=()=>'{"private":"do not echo"}';await assert.rejects(f.driver.configure!(f.entry,{cssWidth:1600,cssHeight:1000,scaleFactor:2},f.options),{code:'DISPLAY_MEASUREMENT_INVALID'});
});
test('Native resize stops after a DPI await when the original display retired',async()=>{
 const f=fixture();let channels=0;f.entry.vnc=()=>{channels++;return rfb('fixture8');};f.hooks.dpi=()=>f.invalidate();
 await assert.rejects(f.driver.configure!(f.entry,{cssWidth:1600,cssHeight:1000,scaleFactor:2},f.options),/Original display retired/);assert.equal(channels,0);assert.equal(f.reads(),0);
});
