import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {safeTerminalPaste,terminalInputChunks,quoteTerminalPath} from '../src/terminal-input.ts';

test('Tool paste keeps plain Unicode and refuses line execution when bracketed paste is unavailable',()=>{
  assert.equal(safeTerminalPaste('中文 😀 printf test',false),'中文 😀 printf test');
  for(const text of ['first\nsecond','first\rsecond','first\r\nsecond','name\targ'])assert.throws(()=>safeTerminalPaste(text,false),/多行/);
  assert.equal(safeTerminalPaste('first\r\nsecond',true),'first\nsecond');
  for(const text of ['\x1b[201~\rwhoami','a\x00b','a\x7fb','\x9b31m','\x03','\x08'])assert.throws(()=>safeTerminalPaste(text,true),/控制字符/);
  assert.throws(()=>safeTerminalPaste('中'.repeat(22000),true),/64 KiB/);
});
test('Large terminal input chunks preserve emoji across the WebSocket boundary',()=>{
  const text='a'.repeat(15999)+'😀'+'中'.repeat(32000)+'🚲';
  const chunks=terminalInputChunks(text);assert.equal(chunks.join(''),text);
  assert.ok(chunks.every(chunk=>chunk.length<=16000&&!/[\ud800-\udbff]$/.test(chunk)&&!/^[\udc00-\udfff]/.test(chunk)));
});
test('Quoted paths stay one literal shell argument including spaces, quotes and substitutions',()=>{
  // Run the real POSIX shell supplied by Git on Windows; never substitute cmd
  // quoting or skip guest-shell coverage merely because /bin/sh is absent.
  const shell=process.platform==='win32'?path.resolve(execFileSync('git',['--exec-path'],{encoding:'utf8'}).trim(),'../../../usr/bin/sh.exe'):'/bin/sh';
  for(const value of ["/home/dev/Transfers/Incoming/中文 file's.txt",'/tmp/$(printf WRONG);x`printf BAD`.txt']){
    const output=execFileSync(shell,['-c',`printf '%s' ${quoteTerminalPath(value)}`],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}});
    assert.equal(output,value);
  }
});
