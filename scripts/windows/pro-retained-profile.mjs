import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const [operation,installed,directory,id,secret]=process.argv.slice(2);
const {openWindowsStore}=await import(pathToFileURL(path.join(installed,'resources/app/dist-server/server/platform/windows/credentials.js')).href);
const store=await openWindowsStore(directory);
try{
 if(operation==='create'){
  const now=new Date().toISOString();
  store.save({id,name:'Synthetic Pro retained profile',instanceName:'mu-win-'+id.replaceAll('-',''),description:'',kind:'vm',color:'blue',cpus:1,memoryGiB:2,diskGiB:32,mounts:[],ports:[],identity:{timezone:'UTC',locale:'zh-CN'},state:'stopped',lastError:null,browserRunning:false,browserUrl:'about:blank',createdAt:now,updatedAt:now,network:{mode:'http',host:'127.0.0.1',port:9,username:'',password:secret,strict:true,transparent:true,noProxy:'',egressLock:{expectedIp:'203.0.113.90'}}});
 }else{assert.equal(operation,'verify');const value=store.get(id);assert.equal(value.name,'Synthetic Pro retained profile');assert.equal(value.network.password,secret);}
 console.log('SYNTHETIC_PROFILE_OK');
}finally{store.close();store.key.fill(0);}
