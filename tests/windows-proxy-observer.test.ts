import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {WINDOWS_PROXY_OBSERVER,WINDOWS_PROXY_SESSION} from '../server/platform/windows/proxy-session.ts';
import {PROXY_SESSION} from '../server/proxy-transport.ts';
import {WindowsTransportDiagnostics} from '../server/platform/windows/transport-diagnostics.ts';

test('Guest proxy evidence accepts only bounded fixed markers and freezes independently of SSH errors',()=>{
 const d=new WindowsTransportDiagnostics();d.ready();d.feedGuest('MU_GUEST_PROXY:FOL');d.feedGuest('LOWING\r\nMU_GUEST_PROXY:RESET\nMU_GUEST_PROXY:DNS\nMU_GUEST_PROXY:RESET private-token\nMU_GUEST_PROXY:PRIVATE\n');
 d.feedGuest('x'.repeat(20000));d.feedGuest('\nMU_GUEST_PROXY:TLS\nMU_GUEST_PROXY:UNAVAILABLE\n');
 const value=d.snapshot();assert.equal(value.guestProxy?.state,'unavailable');assert.deepEqual(value.guestProxy?.failures,{RESET:1,DNS:1,TLS:1});assert.ok(value.guestProxy?.lastFailureAt);assert.deepEqual(value.failures,{});assert.equal(value.ignoredLines,0);assert.equal(/private|token|PRIVATE/.test(JSON.stringify(value)),false);
 value.guestProxy!.failures.RESET=99;assert.equal(d.snapshot().guestProxy?.failures.RESET,1);d.freeze();const frozen=d.snapshot();d.feedGuest('MU_GUEST_PROXY:FOLLOWING\nMU_GUEST_PROXY:TIMEOUT\n');assert.deepEqual(d.snapshot(),frozen);
 assert.equal(PROXY_SESSION.includes('journalctl'),false);assert.ok(WINDOWS_PROXY_SESSION.includes(WINDOWS_PROXY_OBSERVER));
});

test('Actual Python observer redacts before output, bounds malformed lines, rate limits and terminates its reader',()=>{
 const messages=['ERROR connection reset by peer private.example:443 Bearer PRIVATE_TOKEN','ERROR connection reset by peer repeated','ERROR tls: private certificate message','ERROR dns: lookup private.example: i/o timeout','WARN broken pipe','ERROR connection refused','INFO connection reset by peer'];
 const lines=messages.map(MESSAGE=>JSON.stringify({_SYSTEMD_UNIT:'mucodesandbox-tunnel.service',MESSAGE}));lines.push(JSON.stringify({_SYSTEMD_UNIT:'other.service',MESSAGE:'ERROR connection refused PRIVATE_OTHER'}),'not json');
 const child=`import sys,time\nsys.stdout.write('x'*70000+'\\n')\nsys.stdout.write(${JSON.stringify(lines.join('\n')+'\n')})\nsys.stdout.flush()\ntime.sleep(10)`;
 const code=`import subprocess,sys,io,time,json\noriginal=subprocess.Popen\ncreated=[]\noutput=io.StringIO()\nsys.stdout=output\ndef fake(args,**options):\n assert args==['/usr/bin/journalctl','--namespace=mucodesandbox-network','--unit=mucodesandbox-tunnel.service','--boot','--follow','--lines=0','--output=json','--no-pager']\n p=original([sys.executable,'-I','-u','-c',${JSON.stringify(child)}],**options);created.append(p);return p\nsubprocess.Popen=fake\n${WINDOWS_PROXY_OBSERVER}\ntry:\n deadline=time.monotonic()+3\n while 'MU_GUEST_PROXY:REFUSED' not in output.getvalue() and time.monotonic()<deadline:time.sleep(0.01)\nfinally:\n mu_journal_close();mu_journal_thread.join(2)\n for p in created:\n  if p.poll() is None:p.kill();p.wait(timeout=2)\n sys.stdout=sys.__stdout__\nassert not mu_journal_thread.is_alive()\nassert len(created)==1 and created[0].poll() is not None\nprint(json.dumps(output.getvalue().splitlines()))\n`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-I','-X','utf8','-c',"import sys;exec(compile(sys.stdin.read(),'<observer-fixture>','exec'))"],{input:code,encoding:'utf8',timeout:10000,maxBuffer:32768});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);const linesOut=JSON.parse(result.stdout) as string[];assert.deepEqual(linesOut,['MU_GUEST_PROXY:FOLLOWING','MU_GUEST_PROXY:RESET','MU_GUEST_PROXY:TLS','MU_GUEST_PROXY:TIMEOUT','MU_GUEST_PROXY:DNS','MU_GUEST_PROXY:BROKEN_PIPE','MU_GUEST_PROXY:REFUSED']);assert.equal(/private|TOKEN|example/.test(result.stdout),false);
});

test('Concurrent Python status and readiness writes remain complete protocol lines',()=>{
 const code=`import subprocess,sys,io,time,threading,json\noriginal=subprocess.Popen\nentered=threading.Event()\nclass YieldingOutput(io.StringIO):\n def write(self,value):\n  n=super().write(value)\n  if value=='MU_GUEST_PROXY:FOLLOWING':entered.set();time.sleep(0.1)\n  return n\noutput=YieldingOutput();sys.stdout=output\ncreated=[]\ndef fake(args,**options):\n p=original([sys.executable,'-I','-c','import time;time.sleep(10)'],**options);created.append(p);return p\nsubprocess.Popen=fake\n${WINDOWS_PROXY_OBSERVER}\ntry:\n assert entered.wait(3)\n mu_journal_ready()\nfinally:\n mu_journal_close();mu_journal_thread.join(2)\n for p in created:\n  if p.poll() is None:p.kill();p.wait(timeout=2)\n sys.stdout=sys.__stdout__\nassert not mu_journal_thread.is_alive()\nprint(json.dumps(output.getvalue().splitlines()))\n`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-I','-X','utf8','-c',"import sys;exec(compile(sys.stdin.read(),'<observer-readiness>','exec'))"],{input:code,encoding:'utf8',timeout:7000,maxBuffer:4096});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),['MU_GUEST_PROXY:FOLLOWING','MU_PROXY_SESSION_READY']);
});

test('Reader process or thread startup failure remains optional and cannot suppress ownership readiness',()=>{
 for(const phase of ['process','thread']){
  const code=`import subprocess,threading\ndef refused(*args,**kwargs):raise OSError('PRIVATE synthetic resource failure')\n${phase==='process'?'subprocess.Popen=refused':'threading.Thread.start=refused'}\n${WINDOWS_PROXY_OBSERVER}\nif 'mu_journal_thread' in globals() and mu_journal_thread.ident is not None:mu_journal_thread.join(2)\nmu_journal_close()\nmu_journal_ready()\n`;
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-I','-X','utf8','-c',"import sys;exec(compile(sys.stdin.read(),'<observer-unavailable>','exec'))"],{input:code,encoding:'utf8',timeout:5000,maxBuffer:4096});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.deepEqual(result.stdout.trim().split(/\r?\n/),['MU_GUEST_PROXY:UNAVAILABLE','MU_PROXY_SESSION_READY']);assert.equal(result.stderr,'');
 }
});
