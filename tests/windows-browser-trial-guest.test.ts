import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {Environment} from '../shared/types.ts';
import {windowsBrowserTrialEpoch,windowsBrowserTrialUnit,windowsBrowserTrialLaunchProgram,windowsBrowserTrialStatusProgram,windowsBrowserTrialDisplayProgram,windowsBrowserTrialStartProgram,windowsBrowserTrialStopProgram,windowsBrowserTrialInput,parseWindowsBrowserTrialReceipt} from '../server/platform/windows/browser-trial-guest.ts';
import {WINDOWS_BROWSER_TRIAL_PREFERENCES} from '../server/platform/windows/browser-trial-preferences.ts';
import {INSPECT_GUEST_BROWSER_SANDBOX,inspectGuestBrowserSandboxUnit} from '../server/guest-browser-sandbox.ts';
import {WINDOWS_CHROME} from '../server/platform/windows/browser-assets.ts';
import {WINDOWS_BROWSER_CANDIDATE,windowsBrowserReleaseRoot} from '../server/platform/windows/browser-releases.ts';

const epoch='1'.repeat(32),binding='2'.repeat(64),environment={id:'trial-fixture',cpus:1,identity:{locale:'en-US',timezone:'UTC'}} as Environment;
function python(script:string,input:unknown){return new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
 const child=spawn(process.platform==='win32'?'python':'python3',['-I','-c',script],{windowsHide:true});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
});}
test('Every actual candidate program compiles over bounded stdin; transient argv and AppArmor bytes retain exact values',async()=>{
 const programs={launch:windowsBrowserTrialLaunchProgram(environment,epoch),status:windowsBrowserTrialStatusProgram(epoch),accepted:windowsBrowserTrialStatusProgram(epoch,true),display:windowsBrowserTrialDisplayProgram(environment,epoch,binding,'abcdefgh'),start:windowsBrowserTrialStartProgram(environment,epoch),stop:windowsBrowserTrialStopProgram(epoch,binding),preferences:WINDOWS_BROWSER_TRIAL_PREFERENCES};
 for(const program of Object.values(programs)){const frame=windowsBrowserTrialInput(program);assert.equal(frame.readUInt32BE(),Buffer.byteLength(program));assert.equal(frame.subarray(4).toString(),program);assert.ok(frame.length<=262148);}
 assert.ok(Buffer.byteLength(programs.launch)<=98304);
 const result=await python(`import ast,json,sys
programs=json.load(sys.stdin)
trees={name:ast.parse(value,filename=name) for name,value in programs.items()}
for name,value in programs.items():compile(value,name,'exec')
calls=[node for node in ast.walk(trees['start']) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='run']
fixed=[node for node in calls if isinstance(node.args[0],ast.List) and all(isinstance(item,ast.Constant) for item in node.args[0].elts)]
args=[ast.literal_eval(node.args[0]) for node in fixed]
runner=[value for value in args if value[0]=='/usr/bin/systemd-run'];assert len(runner)==1
assert runner[0][-1]==programs['launch']
policy=[node for node in fixed if ast.literal_eval(node.args[0])==['/usr/sbin/apparmor_parser','-r']][0]
raw=ast.literal_eval([item.value.func.value for item in policy.keywords if item.arg=='input'][0])
assert '\\n' in raw and '\\\\n' not in raw
print(json.dumps(dict(compiled=len(programs),argv=runner[0][:-1],policy=raw)))`,programs);
 assert.equal(result.code,0,result.err);const parsed=JSON.parse(result.out);assert.equal(parsed.compiled,7);assert.deepEqual(parsed.argv.slice(-3),['/usr/bin/python3','-I','-c']);
 for(const required of ['--no-ask-password','--collect','--expand-environment=no','--service-type=exec','--unit='+windowsBrowserTrialUnit(epoch),'--property=User=root','--property=Group=root','--property=KillMode=control-group','--property=RuntimeMaxSec=180'])assert.ok(parsed.argv.includes(required));
 assert.equal(parsed.policy,`abi <abi/4.0>,\ninclude <tunables/global>\n${windowsBrowserReleaseRoot(WINDOWS_BROWSER_CANDIDATE.version)}/chrome flags=(unconfined) {\n userns,\n}\n`);
});

test('Candidate metadata and sandbox scope accept only exact fixed identities',()=>{
 for(const value of ['', '../x','F'.repeat(32),'1'.repeat(33),undefined,{},1])assert.throws(()=>windowsBrowserTrialEpoch(value as string),{code:'BROWSER_TRIAL_EPOCH'});
 const receipt={version:1,epoch,priorVersion:WINDOWS_CHROME.version,candidateVersion:WINDOWS_BROWSER_CANDIDATE.version,binding,lease:{session:'11111111-1111-4111-8111-111111111111',boot:'22222222-2222-4222-8222-222222222222'}};
 assert.deepEqual(parseWindowsBrowserTrialReceipt(JSON.stringify(receipt),epoch),receipt);
 for(const value of [{...receipt,extra:true},{...receipt,epoch:'3'.repeat(32)},{...receipt,binding:'x'},{...receipt,priorVersion:'1.0.0.0'},{...receipt,lease:{...receipt.lease,extra:true}}])assert.throws(()=>parseWindowsBrowserTrialReceipt(JSON.stringify(value),epoch),{code:'BROWSER_TRIAL_RECEIPT'});
 assert.equal(inspectGuestBrowserSandboxUnit('mucodesandbox-browser.service'),INSPECT_GUEST_BROWSER_SANDBOX);
 const ordinary="unit='mucodesandbox-browser.service'",trial='unit='+JSON.stringify(windowsBrowserTrialUnit(epoch));
 assert.equal(inspectGuestBrowserSandboxUnit(windowsBrowserTrialUnit(epoch)),INSPECT_GUEST_BROWSER_SANDBOX.replace(ordinary,trial));
 for(const value of ['ssh.service','mucodesandbox-browser-trial-'+'A'.repeat(32)+'.service','mucodesandbox-browser-trial-../x.service'])assert.throws(()=>inspectGuestBrowserSandboxUnit(value));
 for(const identity of [{locale:'__proto__',timezone:'UTC'},{locale:'en-US',timezone:'bad/time'},{locale:'en-US',timezone:''}])assert.throws(()=>windowsBrowserTrialLaunchProgram({...environment,identity} as Environment,epoch),{code:'BROWSER_TRIAL_IDENTITY'});
});
