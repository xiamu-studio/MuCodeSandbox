import {test} from 'node:test';import assert from 'node:assert/strict';import {windowsPasteShortcut,windowsTextDraft,windowsTextToolShortcut} from '../src/windows/text-input.ts';import {safeTerminalPaste} from '../src/terminal-input.ts';
test('Windows floating shortcut accepts missing virtual scan codes without replacing a known physical code',()=>{
 const base={key:'Y',code:'KeyY',ctrlKey:true,shiftKey:true};assert.equal(windowsTextToolShortcut(base,false),true);
 for(const code of ['',undefined,'Unidentified'])for(const key of ['y','Y'])assert.equal(windowsTextToolShortcut({...base,key,code},false),true);
 assert.equal(windowsTextToolShortcut({...base,key:'z'},false),true);assert.equal(windowsTextToolShortcut({...base,code:'KeyZ'},false),false);assert.equal(windowsTextToolShortcut({...base,code:'',key:'z'},false),false);
});
test('Windows floating shortcut keeps composition, modifier and repeat guards with absent scan codes',()=>{
 const base={key:'Y',code:'',ctrlKey:true,shiftKey:true};for(const event of [{...base,isComposing:true},{...base,keyCode:229},{...base,repeat:true},{...base,ctrlKey:false},{...base,shiftKey:false},{...base,altKey:true},{...base,metaKey:true}])assert.equal(windowsTextToolShortcut(event,false),false);assert.equal(windowsTextToolShortcut(base,true),false);
});
test('Windows candidate confirmation and IME fallback keys never become paste shortcuts',()=>{
 const key={key:'Enter',ctrlKey:true,keyCode:13,isComposing:false};assert.equal(windowsPasteShortcut(key,false),true);for(const [event,composing] of [[key,true],[{...key,isComposing:true},false],[{...key,keyCode:229},false],[{...key,ctrlKey:false},false],[{...key,metaKey:true},false],[{...key,altKey:true},false],[{...key,shiftKey:true},false],[{...key,key:'Process'},false]] as const)assert.equal(windowsPasteShortcut(event,composing),false);
});
test('Windows Unicode drafts respect the UTF-8 byte budget and retain nonexecuting terminal paste',()=>{
 const value='中文输入验证 😀\r\n第二行';assert.equal(windowsTextDraft(value),value);assert.equal(safeTerminalPaste(value,true),'中文输入验证 😀\n第二行');assert.equal(windowsTextDraft('中'.repeat(21845)+'x').length,21846);assert.throws(()=>windowsTextDraft('中'.repeat(21846)),/64 KiB/);assert.throws(()=>windowsTextDraft('a\0b'));assert.throws(()=>safeTerminalPaste(value,false),/多行/);assert.equal(safeTerminalPaste('中文输入验证',false),'中文输入验证');
});
