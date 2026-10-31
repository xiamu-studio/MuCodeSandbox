// Node's human reporter can reduce an abruptly exited test file to "test
// failed". Keep a parallel bounded event log, including non-enumerable Error
// fields such as exitCode, signal, cause and failureType. This reporter never
// changes test scheduling, retries, assertions or the runner's exit status.
export function diagnosticValue(value,seen=new Set(),depth=0){
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value==='string')return value.length<=16384?value:{text:value.slice(0,16384),truncatedCharacters:value.length-16384};
 if(value===undefined)return '[undefined]';
 if(typeof value==='bigint')return {bigint:String(value)};
 if(typeof value!=='object')return '['+typeof value+']';
 if(seen.has(value))return '[circular]';if(depth>=8)return '[depth limit]';seen.add(value);
 try{
  if(Array.isArray(value))return value.slice(0,100).map(item=>diagnosticValue(item,seen,depth+1));
  const result={};for(const key of Object.getOwnPropertyNames(value).slice(0,100)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   Object.defineProperty(result,key,{value:descriptor&&'value' in descriptor?diagnosticValue(descriptor.value,seen,depth+1):'[accessor omitted]',enumerable:true,configurable:true});
  }return result;
 }finally{seen.delete(value);}
}
export function diagnosticEvent(event,sequence){
 const result={sequence,type:event.type,data:diagnosticValue(event.data)},encoded=JSON.stringify(result);
 // Bounds apply to one event, never silently to the entire recording.
 if(Buffer.byteLength(encoded)<=128*1024)return encoded+'\n';
 return JSON.stringify({sequence,type:event.type,truncated:true,originalBytes:Buffer.byteLength(encoded),preview:encoded.slice(0,16384)})+'\n';
}
export default async function* windowsTestDiagnostics(source){
 let sequence=0;
 for await(const event of source){
  if(['test:dequeue','test:fail','test:stderr','test:stdout','test:summary','test:diagnostic'].includes(event.type))yield diagnosticEvent(event,++sequence);
 }
}
