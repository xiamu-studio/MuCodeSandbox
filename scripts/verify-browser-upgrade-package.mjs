import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-upgrade-package-smoke-'));
const bundle=path.join(root,'release/browser-upgrade-candidate/mac-arm64/MuCodeSandbox.app');
const artifacts=path.join(root,'test-results',`browser-upgrade-package-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
const report={passed:false,accountFree:true,paidModelCalls:0,bundle,actualElectronPackageTested:true,actualVmUpgradeTested:false,
  scope:'Actual packaged Electron startup, native renderer sandbox, included upgrade modules and stopped-environment version UI; no VM startup or browser upgrade'};
let application;
const errors=[];
try{
  const appRoot=path.join(bundle,'Contents/Resources/app'),digest=value=>createHash('sha256').update(value).digest('hex');
  report.modules={};
  for(const name of ['browser-releases','browser-profile-transaction','browser-install-transaction','guest-browser-runtime','guest-browser','manager','service']){
    const file=`dist-server/server/${name}.js`,compiled=await readFile(path.join(root,file)),packaged=await readFile(path.join(appRoot,file));
    assert.equal(digest(packaged),digest(compiled));report.modules[file]=digest(packaged);
  }
  application=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/MuCodeSandbox'),args:[],chromiumSandbox:true,
    env:{...process.env,MU_DATA_DIR:path.join(owned,'data'),MU_DESKTOP_USER_DATA_DIR:path.join(owned,'desktop'),MU_TEST_CLAUDE:'0'},timeout:60_000});
  const hide=()=>void application.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.webContents.setBackgroundThrottling(false);window.hide();}}).catch(error=>errors.push(String(error)));
  application.on('window',hide);hide();
  const page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('heading',{name:'MuCodeSandbox',exact:true}).waitFor();
  report.application=await application.evaluate(({app})=>({packaged:app.isPackaged,appPath:app.getAppPath(),version:app.getVersion(),
    sandboxDisablingArgumentsAbsent:!process.argv.some(argument=>/^--(?:no-sandbox|disable-(?:gpu|renderer|setuid)-sandbox)(?:=|$)/.test(argument)),
    renderers:app.getAppMetrics().filter(metric=>metric.type==='Tab').map(metric=>({pid:metric.pid,sandboxed:metric.sandboxed}))}));
  assert.ok(report.application.packaged&&report.application.sandboxDisablingArgumentsAbsent);assert.equal(report.application.appPath,appRoot);
  assert.ok(report.application.renderers.length>0&&report.application.renderers.every(item=>item.sandboxed));
  await page.getByRole('button',{name:'新建环境',exact:true}).first().click();
  await page.getByRole('textbox',{name:'环境名称',exact:true}).fill('Packaged browser upgrade acceptance');
  await page.getByRole('button',{name:'创建环境',exact:true}).click();
  await page.getByRole('heading',{name:'Packaged browser upgrade acceptance',exact:true}).waitFor();
  await page.getByRole('button',{name:'浏览器',exact:true}).click();
  await page.getByRole('heading',{name:'浏览器版本',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'更新浏览器',exact:true}).isDisabled());
  assert.ok(await page.getByRole('button',{name:'恢复浏览器',exact:true}).isDisabled());
  await page.getByRole('heading',{name:'浏览器版本',exact:true}).evaluate(node=>node.closest('section').scrollIntoView({block:'center'}));
  const screenshot=await application.evaluate(async({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0];
    // A fully hidden native window may retain its last compositor frame after scrolling.
    window.setOpacity(0);window.showInactive();
    try{
      await new Promise(resolve=>setTimeout(resolve,150));
      const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Native-window capture timed out')),15_000))]);
      const bitmap=image.getBitmap(),colors=new Set();
      for(let offset=0;offset<bitmap.length;offset+=4)colors.add(bitmap.readUInt32LE(offset));
      return {png:image.toPNG().toString('base64'),size:image.getSize(),distinctColors:colors.size};
    }finally{window.hide();window.setOpacity(1);}
  });
  assert.ok(screenshot.size.width>300&&screenshot.size.height>300&&screenshot.distinctColors>32);
  await writeFile(path.join(artifacts,'packaged-version-ui.png'),Buffer.from(screenshot.png,'base64'),{mode:0o600});
  report.screenshot={size:screenshot.size,distinctColors:screenshot.distinctColors,method:'Native transparent inactive-window capture'};
  const snapshot=await page.evaluate(async()=>{const response=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${window.__MU_CONFIG__.token}`}});return response.json();});
  assert.equal(snapshot.environments.length,1);assert.equal(snapshot.environments[0].state,'not_created');assert.equal(snapshot.system.dataDir,path.join(owned,'data'));
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  if(application)await application.close();await rm(owned,{recursive:true});report.testResourcesRemoved=true;report.artifactsDirectory=artifacts;
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(root,'test-results/browser-upgrade-package.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}
