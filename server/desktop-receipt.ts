import {z} from 'zod';
import {AppError} from './errors.ts';
import type {DesktopAppsStatus} from '../shared/guest-desktop.ts';

const app=z.object({
 id:z.enum(['grok-bot','claude-desktop']),installed:z.boolean(),installedVersion:z.string().min(1).max(128).nullable(),
 running:z.boolean(),pid:z.number().int().min(0).max(2147483647),profile:z.string(),
 rendererProtected:z.boolean().nullable(),issue:z.string().max(1024),
}).strict().superRefine((value,context)=>{
 const invalid=value.profile!=='/home/dev/.local/share/mucodesandbox/desktop-clients/'+value.id||
  value.installed!==(value.installedVersion!==null)||
  (value.running?(!value.installed||value.pid<2||value.rendererProtected===null):(value.pid!==0||value.rendererProtected!==null));
 if(invalid)context.addIssue({code:'custom',message:'Contradictory desktop process receipt'});
});
const receipt=z.object({supported:z.literal(true),apps:z.array(app).length(2),displaySharedWithBrowser:z.literal(true),accountTested:z.literal(false)}).strict().refine(value=>new Set(value.apps.map(app=>app.id)).size===2);

// A valid but incomplete JSON object is not proof that the managed clients
// exited. Reject it before assertProtected can retire its monitoring entry.
export function parseRunningDesktopStatus(text:string):DesktopAppsStatus{
 let value:unknown;try{if(Buffer.byteLength(text,'utf8')>16384)throw Error('Oversized desktop receipt');value=JSON.parse(text);}catch{throw new AppError('桌面客户端状态回执无法核对，防护状态未确认',502,'DESKTOP_RECEIPT_INVALID');}
 const result=receipt.safeParse(value);if(!result.success)throw new AppError('桌面客户端状态回执无法核对，防护状态未确认',502,'DESKTOP_RECEIPT_INVALID');
 return {...result.data,apps:result.data.apps.map(value=>({...value,rendererProtected:value.rendererProtected??undefined}))};
}
