import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from './component-package.ts';
import {WINDOWS_BROWSER_REPAIR_PYTHON} from './browser-repair.ts';
import {WINDOWS_BROWSER_RELEASES} from './browser-releases.ts';
import {WINDOWS_BROWSER_SELECTION_HELPERS,windowsBrowserApprovedVersion} from './browser-selection.ts';

// Root-only read of its own interrupted repair. Ordinary callers retain the
// default selection reader's strict repair fence. No executable is opened:
// a damaged component must still be repairable from its approved recipe.
export const WINDOWS_BROWSER_REPAIR_OBSERVATION=String.raw`import os,sys,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,struct,re,uuid,contextlib,fcntl,ctypes
ROOT=pathlib.Path('/opt/mucodesandbox/windows')
STATE=pathlib.Path('/var/lib/mucodesandbox')
ACTIVE=ROOT/'.browser-repair'
RELEASES=${JSON.stringify(Object.fromEntries(WINDOWS_BROWSER_RELEASES.map(release=>[release.version,release])))}
${WINDOWS_COMPONENT_PACKAGE_PYTHON}
${WINDOWS_BROWSER_REPAIR_PYTHON}
${WINDOWS_BROWSER_SELECTION_HELPERS}
if os.geteuid()!=0:raise RuntimeError('Component repair observation requires root')
selected=mu_selected_version(None,True);EXPECTED=RELEASES[selected];TARGET=ROOT/('chrome-'+selected)
if repair_present(STATE):
 repair_directory(STATE)
 for name in ['browser-reset.json','browser-reset','browser-install-transaction.json','browser-upgrade.json','browser-upgrade','browser-install']:
  if repair_present(STATE/name):raise RuntimeError('Another browser transaction needs recovery first')
pending=None;observed=None
if repair_present(ACTIVE):
 observed=repair_record(ACTIVE);repair_inventory(ACTIVE);sequence,data=observed
 pending=dict(epoch=data['epoch'],phase=data['phase'])
mu_selected_version(selected,True)
if observed is None:
 if repair_present(ACTIVE):raise RuntimeError('Component repair appeared during observation')
elif repair_record(ACTIVE)!=observed:raise RuntimeError('Component repair changed during observation')
print(json.dumps(dict(version=1,selectedVersion=selected,pending=pending),sort_keys=True))
`;
const observationSchema=z.object({version:z.literal(1),selectedVersion:windowsBrowserApprovedVersion,pending:z.object({epoch:z.string().regex(/^[a-f0-9]{32}$/),phase:z.enum(['receiving','archive-ready','prepared','published'])}).strict().nullable()}).strict();
export type WindowsBrowserRepairObservation=z.infer<typeof observationSchema>;
export function parseWindowsBrowserRepairObservation(source:string):WindowsBrowserRepairObservation{
 let value:unknown;try{value=JSON.parse(source);}catch{throw new AppError('组件恢复的版本与事务回执无法核对',502,'BROWSER_REPAIR_OBSERVATION');}
 const parsed=observationSchema.safeParse(value);if(!parsed.success)throw new AppError('组件恢复的版本与事务回执无法核对',502,'BROWSER_REPAIR_OBSERVATION');return parsed.data;
}
