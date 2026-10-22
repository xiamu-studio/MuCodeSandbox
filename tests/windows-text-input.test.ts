import {test} from 'node:test';import assert from 'node:assert/strict';import {windowsPasteShortcut,windowsTextDraft} from '../src/windows/text-input.ts';import {safeTerminalPaste} from '../src/terminal-input.ts';
test('Windows candidate confirmation and IME fallback keys never become paste shortcuts',()=>{
 const key={key:'Enter',ctrlKey:true,keyCode:13,isComposing:false};assert.equal(windowsPasteShortcut(key,false),true);for(const [event,composing] of [[key,true],[{...key,isComposing:true},false],[{...key,keyCode:229},false],[{...key,ctrlKey:false},false],[{...key,metaKey:true},false],[{...key,altKey:true},false],[{...key,shiftKey:true},false],[{...key,key:'Process'},false]] as const)assert.equal(windowsPasteShortcut(event,composing),false);
});
test('Windows Unicode drafts respect the UTF-8 byte budget and retain nonexecuting terminal paste',()=>{
 const value='中文输入验证 😀\r\n第二行';assert.equal(windowsTextDraft(value),value);assert.equal(safeTerminalPaste(value,true),'中文输入验证 😀\n第二行');assert.equal(windowsTextDraft('中'.repeat(21845)+'x').length,21846);assert.throws(()=>windowsTextDraft('中'.repeat(21846)),/64 KiB/);assert.throws(()=>windowsTextDraft('a\0b'));assert.throws(()=>safeTerminalPaste(value,false),/多行/);assert.equal(safeTerminalPaste('中文输入验证',false),'中文输入验证');
});
