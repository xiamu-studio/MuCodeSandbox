import {HyperVBrokerClient} from '../../server/platform/windows/broker.ts';
const client=new HyperVBrokerClient(process.argv[2]);
try{await client.call('hello');process.send?.({permitted:true});process.exitCode=1;}
catch(error){process.send?.({denied:(error as {code?:string}).code==='DENIED'});}
