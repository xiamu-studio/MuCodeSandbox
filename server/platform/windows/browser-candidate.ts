import {approvedWindowsBrowserRelease,WINDOWS_BROWSER_CANDIDATE,windowsBrowserReleaseRoot} from './browser-releases.ts';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from './component-package.ts';
import {WINDOWS_BROWSER_RESET_HELPERS} from './browser-reset.ts';
import {WINDOWS_BROWSER_REPAIR_PYTHON} from './browser-repair.ts';
import {AppError} from '../../errors.ts';

// Trusted application program only. Preparing this side-by-side component
// neither selects a browser version nor opens, restores or checkpoints data.
export function windowsBrowserCandidateProgram(begin=true,version:string=WINDOWS_BROWSER_CANDIDATE.version){
 const release=approvedWindowsBrowserRelease(version);
 if(release!==WINDOWS_BROWSER_CANDIDATE)throw new AppError('当前组件不属于待准备候选',409,'BROWSER_CANDIDATE_INVALID');
 const label='.browser-candidate-'+release.version;
 return `import os,sys,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,struct,re,uuid,contextlib,fcntl,ctypes
ROOT=pathlib.Path('/opt/mucodesandbox/windows')
STATE=pathlib.Path('/var/lib/mucodesandbox')
TARGET=pathlib.Path(${JSON.stringify(windowsBrowserReleaseRoot(version))})
REPAIR_LABEL=${JSON.stringify(label)}
REPAIR_RETAINED=${JSON.stringify(label+'-retained')}
ACTIVE=ROOT/REPAIR_LABEL
EXPECTED=${JSON.stringify(release)}
REPAIR_NEW_ONLY=True
REPAIR_STOP_BROWSER=False
REPAIR_KEEP_ARCHIVE=True
${WINDOWS_COMPONENT_PACKAGE_PYTHON}
${WINDOWS_BROWSER_RESET_HELPERS}
${WINDOWS_BROWSER_REPAIR_PYTHON}
if repair_present(ROOT/'.browser-repair'):raise RuntimeError('Current component repair needs recovery first')
print(json.dumps(repair_windows_browser(sys.stdin.buffer,${begin?'True':'False'})))
`;
}
export function windowsBrowserCandidateInput(archive:Uint8Array,begin=true,version:string=WINDOWS_BROWSER_CANDIDATE.version){
 const program=Buffer.from(windowsBrowserCandidateProgram(begin,version));if(program.length>262144)throw Error('Candidate preparation program exceeds its bound');const header=Buffer.alloc(4);header.writeUInt32BE(program.length);return Buffer.concat([header,program,archive]);
}
