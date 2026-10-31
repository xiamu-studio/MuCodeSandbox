'use strict';
const signing=process.env.MU_WINDOWS_SIGNING==='1';
module.exports={
 appId:'local.mucodesandbox.windows.preview',productName:'MuCodeSandbox Windows Preview',asar:false,npmRebuild:false,buildDependenciesFromSource:false,forceCodeSigning:signing,
 files:['**/*','!**/*.pdb','!**/node-pty-electron/**'],
 win:{target:[{target:'nsis',arch:['x64']}],requestedExecutionLevel:'asInvoker',signAndEditExecutable:true,signExecutable:signing},
 nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,deleteAppDataOnUninstall:false,runAfterFinish:false,createDesktopShortcut:true,shortcutName:'MuCodeSandbox Windows Preview'},
};
