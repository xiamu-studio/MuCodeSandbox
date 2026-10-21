'use strict';
function launchOrigin(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.searchParams.size!==1||!/^[-_A-Za-z0-9]{43}$/.test(url.searchParams.get('launch')||''))throw Error('Invalid Windows service launch URL');
 return url.origin;
}
function allowedRequest(origin,value,mainFrame=false){
 try{const url=new URL(value);if(!origin)return url.protocol==='data:';if(mainFrame)return url.origin===origin&&url.pathname==='/';if(url.protocol==='blob:')return url.origin===origin;return url.origin===origin||url.protocol==='ws:'&&url.origin.replace('ws:','http:')===origin;}catch{return false;}
}
function workerEnvironment(source,settings){
 const path=require('node:path'),system=source.SystemRoot||'C:\\Windows',env={SystemRoot:system,WINDIR:system,PATH:path.join(system,'System32'),PATHEXT:'.COM;.EXE;.BAT;.CMD',ComSpec:path.join(system,'System32/cmd.exe'),PSModulePath:path.join(system,'System32/WindowsPowerShell/v1.0/Modules')};
 for(const name of ['SystemDrive','COMPUTERNAME','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','ProgramFiles'])if(source[name])env[name]=source[name];
 for(const name of ['MU_WINDOWS_DATA_DIR','MU_WINDOWS_APP_DIR'])if(settings[name])env[name]=settings[name];
 return env;
}
function statusDocument(title,detail){const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>MuCodeSandbox · Windows</title><style>body{font:16px system-ui;background:#eef4f1;color:#164c3a;margin:0;display:grid;place-content:center;height:100vh}main{max-width:42rem;padding:3rem}h1{font-size:1.6rem}p{line-height:1.8;white-space:pre-wrap}</style><main><h1>'+escape(title)+'</h1><p>'+escape(detail)+'</p></main></html>';}
module.exports={launchOrigin,allowedRequest,workerEnvironment,statusDocument};
