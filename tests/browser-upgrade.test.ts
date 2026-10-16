import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { APPROVED_BROWSER_RELEASES, approvedBrowserRelease, browserReleaseFromRecipe, CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { ensureGuestBrowser } from '../server/guest-browser-runtime.ts';
import { RECOVER_BROWSER_INSTALL_SCRIPT } from '../server/browser-install-transaction.ts';
import { browserProfileCompatibilityScript } from '../server/browser-profile-version.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { Manager } from '../server/manager.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { Environment } from '../shared/types.ts';
import { environmentSchema } from '../server/validation.ts';

test('Unknown browser versions and altered approval recipes fail before guest or download access',async()=>{
  assert.throws(()=>approvedBrowserRelease('../arbitrary'),{code:'BROWSER_VERSION_UNAPPROVED'});
  assert.throws(()=>browserReleaseFromRecipe(CURRENT_BROWSER_RELEASE.recipe.replace(CURRENT_BROWSER_RELEASE.sha256,'0'.repeat(64))),{code:'BROWSER_RECIPE_UNAPPROVED'});
  const runtime=new LimaRuntime('/unused');runtime.management=async()=>{throw new Error('No guest access allowed');};
  const e={...environmentSchema.parse({name:'Version approval'}),state:'running'} as Environment;
  await assert.rejects(ensureGuestBrowser(runtime,e,{},'99.1.2.3'),{code:'BROWSER_VERSION_UNAPPROVED'});
});

test('Opening an existing approved older browser never upgrades its profile implicitly',async()=>{
  const runtime=new LimaRuntime('/unused'),previous=APPROVED_BROWSER_RELEASES[0];
  runtime.management=async(_e,args,options)=>{
    if(options?.input===RECOVER_BROWSER_INSTALL_SCRIPT)return previous.recipe;
    if(options?.input===browserProfileCompatibilityScript(previous.version))return '';
    assert.ok(args[2]?.includes(`chromium-${previous.version}/chrome-linux-arm64/chrome`));
    return '/usr/bin/Xvfb';
  };
  const e={...environmentSchema.parse({name:'Explicit browser upgrade'}),state:'running'} as Environment;
  assert.equal((await ensureGuestBrowser(runtime,e)).version,previous.version);
});

test('Browser maintenance holds the normal environment lock and records recoverable failure truthfully',async()=>{
  const root=await mkdtemp(path.join(homedir(),'.mu-upgrade-unit-'));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let fail=false,calls=0;
  const browser:BrowserHost={native:false,available:async()=>false,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{},
    update:async()=>{calls++;await gate;if(fail)throw new Error('upgrade rejected');},recover:async()=>{calls++;}};
  const manager=new Manager(root,browser);manager.assertAccess=async()=>undefined;
  try{
    const environment=await manager.create({name:'Upgrade locking'});manager.store.state(environment.id,'running');
    const job=await manager.maintainBrowser(environment.id,'update');
    await assert.rejects(manager.maintainBrowser(environment.id,'recover'),{code:'OPERATION_IN_PROGRESS'});
    await assert.rejects(manager.openBrowser(environment.id),{code:'OPERATION_IN_PROGRESS'});
    fail=true;release();await manager.tasks.get(job.id)?.promise;
    assert.equal(manager.store.jobs().find(item=>item.id===job.id)?.status,'failed');
    assert.equal(manager.store.get(environment.id).state,'running');assert.equal(manager.active.has(environment.id),false);
    const recovery=await manager.maintainBrowser(environment.id,'recover');await manager.tasks.get(recovery.id)?.promise;
    assert.equal(manager.store.jobs().find(item=>item.id===recovery.id)?.status,'succeeded');assert.equal(calls,2);
  }finally{release();await manager.close();await rm(root,{recursive:true,force:true});}
});
