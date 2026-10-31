import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowserStartupTiming} from '../server/platform/windows/browser-timing.ts';

test('Browser phase timing reports only completed bounded durations',()=>{
 let now=0;const timing=new BrowserStartupTiming(()=>now);
 timing.browserPhase();now=120;timing.browserPhase();now=200;timing.browserPhase();
 assert.equal(timing.browserDetails(),undefined);
 now=260;timing.browserPhase();
 assert.equal(timing.browserDetails(),'浏览器启动细分：启动与连接 120 ms；隔离检查 80 ms；启动页及保护检查 60 ms。');
});

test('Homepage timing reports only fixed durations after all required steps',async()=>{
 let now=0;const timing=new BrowserStartupTiming(()=>now);
 const step=async(name:'prepare'|'guard'|'install'|'navigate',elapsed:number)=>timing.homeStep(name,async()=>{now+=elapsed;return 'result';});
 assert.equal(await step('prepare',2),'result');await step('guard',3);await step('install',4);await step('guard',5);await step('navigate',6);
 assert.equal(timing.homeDetails(),undefined);await step('guard',7);
 assert.equal(timing.homeDetails(),'本地首页启动耗时：准备 2 ms；三次保护核验 3/5/7 ms；写入 4 ms；打开 6 ms。');
});
