import {WINDOWS_DESKTOP_COMPONENT_RELEASES,type WindowsDesktopComponentsStatus} from '../../shared/windows-desktop-components.ts';
const states=['stopped','unavailable','verified','missing','pending','untrusted','busy'];
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function checkedWindowsDesktopComponents(value:unknown):WindowsDesktopComponentsStatus{
 if(!exact(value,['version','enabled','apps'])||value.version!==1||typeof value.enabled!=='boolean'||!Array.isArray(value.apps)||value.apps.length!==2)throw Error('桌面组件状态回执无法核对，请刷新后重试');
 const seen=new Set<string>();
 for(const app of value.apps){
  if(!exact(app,['id','state','installedVersion','availableVersion','architecture','message']))throw Error('桌面组件状态回执无法核对，请刷新后重试');
  const release=WINDOWS_DESKTOP_COMPONENT_RELEASES.find(item=>item.id===app.id);
  if(!release||seen.has(release.id)||!states.includes(app.state as string)||app.architecture!=='amd64'||app.availableVersion!==release.version||app.installedVersion!==(app.state==='verified'?release.version:null)||typeof app.message!=='string'||app.message.length>500)throw Error('桌面组件状态回执无法核对，请刷新后重试');
  seen.add(release.id);
 }
 return value as unknown as WindowsDesktopComponentsStatus;
}
