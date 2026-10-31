import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedWindowsDesktopComponents} from '../src/windows/desktop-component-state.ts';
import {WINDOWS_DESKTOP_COMPONENT_RELEASES} from '../shared/windows-desktop-components.ts';
import {windowsDesktopAsset} from '../server/platform/windows/desktop-assets.ts';

function value(){return {version:1,enabled:true,apps:WINDOWS_DESKTOP_COMPONENT_RELEASES.map(app=>({id:app.id,state:'missing',installedVersion:null as string|null,availableVersion:app.version,architecture:'amd64',message:'合成缺少组件'}))};}
test('Windows UI release metadata matches the independently pinned AMD64 component catalogs',()=>{
 for(const release of WINDOWS_DESKTOP_COMPONENT_RELEASES){const asset=windowsDesktopAsset(release.id);assert.equal(release.version,asset.version);assert.equal(release.downloadBytes,asset.bytes);}
});
test('Component UI accepts complete fixed receipts and refuses duplicate, stale-version, ambiguous or extra state',()=>{
 const good=value();assert.equal(checkedWindowsDesktopComponents(good),good);
 for(const state of ['stopped','unavailable','verified','missing','pending','untrusted','busy']){const input=value();input.apps[0].state=state;input.apps[0].installedVersion=state==='verified'?input.apps[0].availableVersion:null;assert.equal(checkedWindowsDesktopComponents(input),input);}
 for(const mutate of [(v:ReturnType<typeof value>)=>v.apps.pop(),(v:ReturnType<typeof value>)=>v.apps.push(v.apps[0]),(v:ReturnType<typeof value>)=>v.apps[1]=v.apps[0],(v:ReturnType<typeof value>)=>Object.assign(v,{unexpected:true}),(v:ReturnType<typeof value>)=>Object.assign(v.apps[0],{unexpected:true}),(v:ReturnType<typeof value>)=>v.apps[0].availableVersion='0.0.0' as never,(v:ReturnType<typeof value>)=>v.apps[0].state='running',(v:ReturnType<typeof value>)=>v.apps[0].message='x'.repeat(501),(v:ReturnType<typeof value>)=>Object.assign(v.apps[0],{installedVersion:'0.68.1'}),(v:ReturnType<typeof value>)=>Object.assign(v.apps[0],{architecture:'arm64'})]){const input=value();mutate(input);assert.throws(()=>checkedWindowsDesktopComponents(input),/回执无法核对/);}
});
