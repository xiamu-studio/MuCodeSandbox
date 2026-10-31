async function clipboardText(action:'read'|'write',value?:string){
 try{const desktop=window.muWindowsDesktop;if(action==='read')return desktop?.readClipboardText?await desktop.readClipboardText():await navigator.clipboard.readText();if(desktop?.writeClipboardText)await desktop.writeClipboardText(value!);else await navigator.clipboard.writeText(value!);return '';}
 catch(error){throw Error((error as Error).message.replace(/^Error invoking remote method 'mu-windows:clipboard-text': (?:Error: )?/,''));}
}
export const windowsHostClipboard={readText:()=>clipboardText('read'),writeText:(value:string)=>clipboardText('write',value)};
