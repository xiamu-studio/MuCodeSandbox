'use strict';
module.exports={
 appId:'local.mucodesandbox.windows.preview',productName:'MuCodeSandbox Windows Preview',asar:false,npmRebuild:false,buildDependenciesFromSource:false,forceCodeSigning:false,
 files:['**/*','!**/*.pdb','!**/node-pty-electron/**'],
 win:{target:[{target:'nsis',arch:['x64']}],requestedExecutionLevel:'asInvoker',signAndEditExecutable:true,signExecutable:false},
 nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,deleteAppDataOnUninstall:false,runAfterFinish:false,createDesktopShortcut:false,shortcutName:'MuCodeSandbox Windows Preview'},
};
