import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';

function fixture() {
  return { unitActive: true, developmentUid: 502, processes: ['renderer', 'gpu-process'].map((role, index) => ({
    pid: 200 + index, role, uid: 502, seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000',
    separatePidNamespace: role === 'renderer', noSandboxFlag: false,
    threads: [200 + index, 300 + index].map(tid => ({ tid, seccomp: 2, noNewPrivileges: 1, effectiveCapabilities: '0000000000000000' })),
  })) };
}

test('Browser startup accepts separate renderer and graphics policies with all threads protected', () => {
  const value = fixture(); assert.deepEqual(assertGuestBrowserSandbox(value), value);
});

test('Browser startup refuses missing roles, root, capabilities, disabled isolation and unprotected sibling threads', () => {
  const changes: ((value: ReturnType<typeof fixture>) => void)[] = [
    value => { value.unitActive = false; },
    value => { value.processes.pop(); },
    value => { value.processes[1].role = 'renderer'; },
    value => { value.processes[1].uid = 0; },
    value => { value.processes[1].uid = 501; },
    value => { value.processes[1].seccomp = 0; },
    value => { value.processes[1].noNewPrivileges = 0; },
    value => { value.processes[1].effectiveCapabilities = '0000000000000001'; },
    value => { value.processes[0].separatePidNamespace = false; },
    value => { value.processes[1].noSandboxFlag = true; },
    value => { value.processes[1].threads = []; },
    value => { value.processes[1].threads[1].seccomp = 0; },
    value => { value.processes[1].threads[1].noNewPrivileges = 0; },
    value => { value.processes[1].threads[1].effectiveCapabilities = '0000000000000001'; },
    value => { value.processes[1].threads[0].tid = 999; },
    value => { value.processes[1].threads[1].tid = value.processes[1].threads[0].tid; },
    value => { value.processes[1].pid = value.processes[0].pid; },
  ];
  for (const change of changes) {
    const value = fixture(); change(value);
    assert.throws(() => assertGuestBrowserSandbox(value), { code: 'BROWSER_SANDBOX_FAILED' });
  }
  for (const value of [null, {}, { ...fixture(), developmentUid: 0 }])
    assert.throws(() => assertGuestBrowserSandbox(value), { code: 'BROWSER_SANDBOX_FAILED' });
});
