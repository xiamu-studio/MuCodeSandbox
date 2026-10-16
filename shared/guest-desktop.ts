export type DesktopAppId = 'grok-bot' | 'claude-desktop';
export const DESKTOP_APPS = [
  {id:'grok-bot' as const,name:'Grok Bot',version:'0.68.1',downloadMB:99.3,source:'https://x.ai/bot',note:'仅保护本地客户端；Bot 云电脑出口不由本项目控制'},
  {id:'claude-desktop' as const,name:'Claude Desktop',version:'2.31226.1',downloadMB:174.1,source:'https://code.claude.com/docs/en/desktop-linux',note:'官方 Linux beta'},
] as const;
export interface DesktopAppStatus {id:DesktopAppId;installed:boolean;installedVersion:string|null;running:boolean;pid:number;profile:string;rendererProtected?:boolean;issue?:string}
export interface DesktopAppsStatus {supported:boolean;apps:DesktopAppStatus[];displaySharedWithBrowser:true;accountTested:false}
