import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WINDOWS_CLIENT_RUNTIME_REQUIREMENTS,WINDOWS_CLIENT_RUNTIME_PYTHON} from '../server/platform/windows/desktop-runtime.ts';
import {WINDOWS_DESKTOP_PACKAGES,desktopDependenciesScript} from '../server/platform/windows/desktop-install.ts';
import {windowsDesktopComponentProgram} from '../server/platform/windows/desktop-component.ts';

test('Fixed Noble recipe satisfies reviewed vendor required alternatives without installing vendor recommendations',()=>{
 // Declarations from the two pinned official archives, independently reviewed.
 const declarations={
  'grok-bot':'libgtk-3-0,libnotify4,libnss3,libxss1,libxtst6,xdg-utils,libatspi2.0-0,libuuid1,libsecret-1-0,libasound2t64|libasound2,libgbm1,libxkbcommon0,libdrm2',
  'claude-desktop':'libgtk-3-0,libnotify4,libnss3,xdg-utils,libatspi2.0-0,libdrm2,libgbm1,libxcb-dri3-0,libsecret-1-0,kde-cli-tools|kde-runtime|trash-cli|libglib2.0-bin|gvfs,libc6,libxtst6,libuuid1,libpipewire-0.3-0,xdg-desktop-portal,xdg-desktop-portal-gtk|xdg-desktop-portal-gnome|xdg-desktop-portal-kde',
 };
 const aliases:Record<string,string>={'libgtk-3-0':'libgtk-3-0t64','libatspi2.0-0':'libatspi2.0-0t64','libpipewire-0.3-0':'libpipewire-0.3-0t64'};
 for(const [application,required] of Object.entries(declarations))for(const alternatives of required.split(',')){
  const names=alternatives.split('|').map(name=>aliases[name]??name);
  assert.ok(names.some(name=>(WINDOWS_CLIENT_RUNTIME_REQUIREMENTS[application as keyof typeof WINDOWS_CLIENT_RUNTIME_REQUIREMENTS] as readonly string[]).includes(name)),application+': '+alternatives);
  assert.ok(names.some(name=>(WINDOWS_DESKTOP_PACKAGES as readonly string[]).includes(name)),alternatives);
 }
 assert.equal(new Set(WINDOWS_DESKTOP_PACKAGES).size,WINDOWS_DESKTOP_PACKAGES.length);
 const script=desktopDependenciesScript();assert.ok(script.includes('--no-install-recommends --no-remove install'));
 assert.ok(script.indexOf('apt-get')<script.indexOf(WINDOWS_CLIENT_RUNTIME_PYTHON));
 for(const name of ['qemu-system-x86','ovmf','virtiofsd','pipewire-pulse'])assert.equal((WINDOWS_DESKTOP_PACKAGES as readonly string[]).includes(name),false);
 assert.ok(windowsDesktopComponentProgram('claude-desktop','install').includes('assert_desktop_runtime("claude-desktop")'));
 assert.equal(windowsDesktopComponentProgram('claude-desktop','inspect').includes('assert_desktop_runtime'),false);
});

test('Production Python package preflight refuses partial, wrong architecture, malformed or old libc receipts before client preparation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-runtime-'));
 try{
  const file=path.join(root,'runtime.py');await writeFile(file,WINDOWS_CLIENT_RUNTIME_PYTHON+String.raw`
import types
calls=[];fault=None
def fake_run(args):
 calls.append(args)
 if args==['/usr/bin/dpkg','--print-architecture']:return types.SimpleNamespace(returncode=0,stdout=b'arm64\n' if fault=='architecture' else b'amd64\n',stderr=b'')
 if args[:2]==['/usr/bin/dpkg','--compare-versions']:
  assert args[3:]==['ge','2.34'];return types.SimpleNamespace(returncode=int(fault=='old-libc'))
 assert args[:2]==['/usr/bin/dpkg-query','-W'] and args[2]=='-f='+chr(36)+'{db:Status-Status}'+r'\t'+chr(36)+'{Architecture}'+r'\t'+chr(36)+'{Version}'+r'\n'
 raw={'partial':b'unpacked\tamd64\t2.40\n','foreign':b'installed\tarm64\t2.40\n','duplicate':b'installed\tamd64\t2.40\ninstalled\tamd64\t2.40\n','invalid-version':b'installed\tamd64\t--bad\n','oversized':b'x'*1025,'nonascii':b'\xff','newline':b'installed\tamd64\t2.40\n\n'}.get(fault,b'installed\tamd64\t2.40-1ubuntu1\n')
 return types.SimpleNamespace(returncode=int(fault=='missing'),stdout=raw,stderr=b'x'*1025 if fault=='stderr' else b'')
mu_runtime_run=fake_run
for application in ['grok-bot','claude-desktop']:
 calls.clear();assert assert_desktop_runtime(application)['state']=='packages-verified'
 assert len([a for a in calls if a[0]=='/usr/bin/dpkg-query'])==len(MU_CLIENT_REQUIREMENTS[application])
checks=[]
for fault in ['architecture','partial','foreign','duplicate','invalid-version','oversized','nonascii','newline','missing','stderr','old-libc']:
 try:assert_desktop_runtime('claude-desktop')
 except RuntimeError:checks.append(fault)
 else:raise AssertionError('Accepted '+fault)
calls.clear()
try:assert_desktop_runtime('unknown')
except RuntimeError:pass
else:raise AssertionError('Unknown accepted')
assert not calls
print(json.dumps(dict(checks=checks,actualDpkg=False,clientExecuted=False)))
`);
  const value=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',file],{windowsHide:true,timeout:10000})).stdout);
  assert.equal(value.checks.length,11);assert.equal(value.actualDpkg,false);assert.equal(value.clientExecuted,false);
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-runtime-/);await rm(root,{recursive:true,force:true});}
});
