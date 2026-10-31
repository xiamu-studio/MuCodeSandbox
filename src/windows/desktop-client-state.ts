import type {WindowsDesktopClientsState} from '../../shared/windows-desktop-clients.ts';
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function checkedWindowsDesktopClients(value:unknown):WindowsDesktopClientsState{
 const fail=()=>{throw Error('桌面客户端状态回执无法核对，请刷新后重试');};
 if(!exact(value,['version','enabled','apps','accountTested'])||value.version!==1||typeof value.enabled!=='boolean'||value.accountTested!==false||!Array.isArray(value.apps)||value.apps.length!==2)return fail();
 const seen=new Set();
 for(const app of value.apps){
  if(!exact(app,['id','state','viewId','rendererProtected'])||!['grok-bot','claude-desktop'].includes(app.id as string)||seen.has(app.id)||!['idle','starting','running','stopping','failed','unavailable'].includes(app.state as string))return fail();seen.add(app.id);
  const hasView=typeof app.viewId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(app.viewId);
  if(['idle','unavailable'].includes(app.state as string)?app.viewId!==null||app.rendererProtected!==null:!hasView||app.rendererProtected!==(app.state==='running'?true:null))return fail();
 }
 return value as unknown as WindowsDesktopClientsState;
}
