import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {checkedWindowsDesktopClients} from '../src/windows/desktop-client-state.ts';
function status(){return {version:1,enabled:true,accountTested:false,apps:[{id:'grok-bot',state:'idle',viewId:null as string|null,rendererProtected:null as true|null},{id:'claude-desktop',state:'idle',viewId:null as string|null,rendererProtected:null as true|null}]};}
test('Desktop client UI accepts only complete, unique and internally consistent fixed-client states',()=>{
 for(const state of ['idle','starting','running','stopping','failed','unavailable']){const value=status();Object.assign(value.apps[0],{state,viewId:['idle','unavailable'].includes(state)?null:randomUUID(),rendererProtected:state==='running'?true:null});assert.equal(checkedWindowsDesktopClients(value),value);}
});
test('Missing, duplicate, contradictory and extra client fields cannot enable a viewer or hide missing protection',()=>{
 for(const change of [(v:ReturnType<typeof status>)=>v.apps.pop(),(v:ReturnType<typeof status>)=>v.apps[1]=v.apps[0],(v:ReturnType<typeof status>)=>Object.assign(v,{extra:true}),(v:ReturnType<typeof status>)=>Object.assign(v,{accountTested:true}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{state:'running',viewId:randomUUID(),rendererProtected:false}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{state:'running',rendererProtected:true}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{state:'starting',viewId:'not-a-view'}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{state:'idle',viewId:randomUUID()}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{id:'other'}),(v:ReturnType<typeof status>)=>Object.assign(v.apps[0],{extra:true})]){const value=status();change(value);assert.throws(()=>checkedWindowsDesktopClients(value),/回执无法核对/);}
});
