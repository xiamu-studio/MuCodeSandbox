import { z } from 'zod';
import { AppError } from './errors.ts';

const threadSchema = z.object({
  tid: z.number().int().positive(), seccomp: z.literal(2), noNewPrivileges: z.literal(1),
  effectiveCapabilities: z.string().regex(/^0+$/),
});
const processSchema = z.object({
  pid: z.number().int().positive(), role: z.enum(['renderer', 'gpu-process']),
  uid: z.number().int().positive(), seccomp: z.literal(2), noNewPrivileges: z.literal(1),
  effectiveCapabilities: z.string().regex(/^0+$/), separatePidNamespace: z.boolean(),
  noSandboxFlag: z.literal(false), threads: z.array(threadSchema).min(1),
});
const reportSchema = z.object({
  unitActive: z.literal(true), developmentUid: z.number().int().positive(),
  processes: z.array(processSchema).min(2),
});

export function assertGuestBrowserSandbox(value: unknown) {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw new AppError('浏览器进程防护检查未通过', 500, 'BROWSER_SANDBOX_FAILED');
  const report = parsed.data;
  const roles = new Set(report.processes.map(process => process.role));
  const valid = roles.has('renderer') && roles.has('gpu-process') &&
    new Set(report.processes.map(process => process.pid)).size === report.processes.length &&
    report.processes.every(process => process.uid === report.developmentUid &&
      (process.role !== 'renderer' || process.separatePidNamespace) &&
      process.threads.some(thread => thread.tid === process.pid) &&
      new Set(process.threads.map(thread => thread.tid)).size === process.threads.length);
  if (!valid) throw new AppError('浏览器进程防护检查未通过', 500, 'BROWSER_SANDBOX_FAILED');
  return report;
}

// Read only this service's cgroup. A protected unrelated Chrome cannot satisfy the check.
export const INSPECT_GUEST_BROWSER_SANDBOX = `import json,pathlib,pwd,shlex,subprocess,sys
unit='mucodesandbox-browser.service'
active=subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0
group=subprocess.check_output(['systemctl','show',unit,'--property=ControlGroup','--value'],text=True).strip()
assert group=='/system.slice/'+unit
directory=pathlib.Path('/sys/fs/cgroup'+group)
pids=set()
for file in directory.rglob('cgroup.procs'):pids.update(file.read_text().split())
initial=pathlib.Path('/proc/1/ns/pid').readlink().as_posix()
rows=[]
for pid in sorted(pids):
 process=pathlib.Path('/proc')/pid
 try:
  if process.joinpath('exe').readlink().as_posix()!=sys.argv[1]:continue
  args=[part.decode() for part in process.joinpath('cmdline').read_bytes().split(bytes([0])) if part]
  if len(args)==1:args=shlex.split(args[0])
  role=next((value.split('=',1)[1] for value in args if value.startswith('--type=')),'browser')
  if role not in ('renderer','gpu-process'):continue
  status=dict(line.split(':',1) for line in process.joinpath('status').read_text().splitlines() if ':' in line)
  threads=[]
  for thread in process.joinpath('task').glob('[0-9]*'):
   try:
    values=dict(line.split(':',1) for line in thread.joinpath('status').read_text().splitlines() if ':' in line)
    threads.append(dict(tid=int(thread.name),seccomp=int(values['Seccomp']),noNewPrivileges=int(values['NoNewPrivs']),effectiveCapabilities=values['CapEff'].strip()))
   except (FileNotFoundError,ProcessLookupError):pass
  rows.append(dict(pid=int(pid),role=role,uid=int(status['Uid'].split()[0]),seccomp=int(status['Seccomp']),noNewPrivileges=int(status['NoNewPrivs']),effectiveCapabilities=status['CapEff'].strip(),separatePidNamespace=process.joinpath('ns/pid').readlink().as_posix()!=initial,noSandboxFlag=any(value in args for value in ('--no-sandbox','--disable-gpu-sandbox','--disable-seccomp-filter-sandbox','--disable-namespace-sandbox')),threads=threads))
 except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps(dict(unitActive=active,developmentUid=pwd.getpwnam('dev').pw_uid,processes=rows)))
`;

// Keep the ordinary Mac/Windows inspection byte-for-byte; candidates have a
// separate, exact epoch service cgroup, never an arbitrary requested unit.
export function inspectGuestBrowserSandboxUnit(unit:string){
 if(unit==='mucodesandbox-browser.service')return INSPECT_GUEST_BROWSER_SANDBOX;
 if(!/^mucodesandbox-browser-trial-[a-f0-9]{32}\.service$/.test(unit))throw new AppError('候选浏览器服务身份无效',400,'BROWSER_TRIAL_UNIT');
 const marker="unit='mucodesandbox-browser.service'";if(INSPECT_GUEST_BROWSER_SANDBOX.split(marker).length!==2)throw Error('Sandbox unit template changed');
 return INSPECT_GUEST_BROWSER_SANDBOX.replace(marker,'unit='+JSON.stringify(unit));
}
