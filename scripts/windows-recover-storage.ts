// Explicit operator entry point. Close the Windows app before starting recovery.
import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {installBroker,installedBrokerPath,startBroker} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {reviewProtectedStorage,adoptProtectedStorage} from '../server/platform/windows/recovery.ts';
const {values,positionals}=parseArgs({allowPositionals:true,options:{id:{type:'string'},'image-sha256':{type:'string'},review:{type:'string'},'confirm-name':{type:'string'},'install-broker':{type:'boolean',default:false}}});
const mode=positionals[0];
if(process.platform!=='win32'||positionals.length!==1||!['review','adopt'].includes(mode)||!values.review||mode==='review'&&(!values.id||!values['image-sha256']||values['confirm-name'])||mode==='adopt'&&(!values['confirm-name']||values.id||values['image-sha256']))throw Error('Windows recovery: review --id UUID --image-sha256 SHA256 --review NEW_FILE, then adopt --review FILE --confirm-name FULL_VM_NAME. Optional: --install-broker');
if(values['install-broker'])await installBroker(windowsRuntimeDirectory());
const client=await startBroker(await installedBrokerPath(),{recoveryOnly:true});
try{
 if(mode==='review'){
  const result=await reviewProtectedStorage(client,values.id!,values['image-sha256']!);
  await writeFile(values.review,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
 }else process.stdout.write(JSON.stringify(await adoptProtectedStorage(client,JSON.parse(await readFile(values.review,'utf8')),values['confirm-name']!),null,2)+'\n');
}finally{await client.call('shutdown').catch(()=>{});}
