import {CLIPBOARD_MAX_BYTES} from '../../shared/guest-exchange.ts';
interface TextKey {key:string;ctrlKey:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;isComposing?:boolean;keyCode?:number}
export function windowsTextToolShortcut(event:TextKey&{code?:string;repeat?:boolean},composing:boolean){const y=event.code==='KeyY'||(!event.code||event.code==='Unidentified')&&/^[yY]$/.test(event.key);return !composing&&!event.isComposing&&event.keyCode!==229&&!event.repeat&&event.ctrlKey&&!!event.shiftKey&&!event.altKey&&!event.metaKey&&y;}
export function windowsPasteShortcut(event:TextKey,composing:boolean){return event.key==='Enter'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!composing&&!event.isComposing&&event.keyCode!==229;}
export function windowsTextDraft(value:string){if(value.includes('\0')||new TextEncoder().encode(value).length>CLIPBOARD_MAX_BYTES)throw Error('文字最多64 KiB，且不能包含空字符。');return value;}
