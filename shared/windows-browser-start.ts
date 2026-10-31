import {BROWSER_HOME_URL,usesBrowserHome} from './browser-home.ts';

// Valid environment configuration value; it is never requested over HTTP.
export const WINDOWS_BLANK_PAGE_URL='https://blank.mucodesandbox.invalid/';
export interface WindowsBrowserStartPage {kind:'blank'|'home'|'url';url:string}
export function windowsBrowserStartPage(value:unknown):WindowsBrowserStartPage{
 if(typeof value!=='string'||value.length>2048)throw Error('请选择空白页、浏览器首页或有效的 HTTP / HTTPS 网址');
 if(value.trim()==='about:blank')return {kind:'blank',url:WINDOWS_BLANK_PAGE_URL};
 let url:URL;try{url=new URL(value);}catch{throw Error('请输入有效的 HTTP 或 HTTPS 启动页网址');}
 if(url.href.length>2048)throw Error('启动页网址编码后超过 2048 字符，请缩短网址');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('启动页只支持不含账号密码的 HTTP 或 HTTPS 网址');
 if(url.href===WINDOWS_BLANK_PAGE_URL)return {kind:'blank',url:WINDOWS_BLANK_PAGE_URL};
 if(usesBrowserHome(url.href))return {kind:'home',url:BROWSER_HOME_URL};
 return {kind:'url',url:url.href};
}
