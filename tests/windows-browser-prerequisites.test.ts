import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {verifyWindowsDesktop} from '../server/platform/windows/browser-guest.ts';
import {VERIFY_WINDOWS_DISPLAY_COMPONENTS} from '../server/platform/windows/display-guest.ts';

test('Browser preparation rejects each missing display prerequisite',()=>{
 const script=verifyWindowsDesktop(),start=script.indexOf("for executable in ['xkbcomp'"),end=script.indexOf('\nfor folder,expected,relative',start);
 assert.match(script,/^sudo \/usr\/bin\/python3 -I - /);
 assert.ok(start>=0&&end>start);
 const check=script.slice(start,end);
 const python=`
import shutil
names=['xkbcomp','xauth','x11vnc','xsettingsd','openbox','wmctrl','pactl']
seen=[]
missing=None
def lookup(name):
 seen.append(name)
 return None if name==missing else '/synthetic/'+name
shutil.which=lookup
def verify():
 ${check.replaceAll('\n','\n ')}
verify()
assert seen==names
for name in names:
 missing=name;seen=[]
 try: verify()
 except RuntimeError: pass
 else: raise AssertionError('missing prerequisite accepted')
 assert seen[-1]==name
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('Shared display preparation rejects each missing prerequisite',()=>{
 const script=VERIFY_WINDOWS_DISPLAY_COMPONENTS,start=script.indexOf("for executable in ['xkbcomp'"),end=script.indexOf('\nfor executable in [\'/usr/libexec/',start);
 assert.ok(start>=0&&end>start);
 const check=script.slice(start,end);
 const python=`
import shutil
names=['xkbcomp','xauth','x11vnc','xsettingsd','dump_xsettings','xdpyinfo','openbox','wmctrl','pactl','dbus-daemon','gdbus','timeout']
seen=[]
missing=None
def lookup(name):
 seen.append(name)
 return None if name==missing else '/synthetic/'+name
shutil.which=lookup
def verify():
 ${check.replaceAll('\n','\n ')}
verify()
assert seen==names
for name in names:
 missing=name;seen=[]
 try: verify()
 except RuntimeError: pass
 else: raise AssertionError('missing prerequisite accepted')
 assert seen[-1]==name
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
