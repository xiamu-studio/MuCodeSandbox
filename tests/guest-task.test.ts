import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LimaRuntime } from '../server/runtime.ts';
import { GUEST_TASK_RUN, GUEST_TASK_CANCEL } from '../server/guest-task.ts';
import { environmentSchema } from '../server/validation.ts';
import { AppError } from '../server/errors.ts';
import type { Environment } from '../shared/types.ts';

const environment = (): Environment => ({ ...environmentSchema.parse({ name: 'Task test' }), id: randomUUID(), instanceName: 'mu-task-test', state: 'running', lastError: null, browserRunning: false, createdAt: '', updatedAt: '' });

test('guest commands preserve literal argv and stdin behind a bounded guest supervisor', async () => {
  const runtime = new LimaRuntime('/tmp/unused');
  runtime.command = async (args, options) => {
    const index = args.indexOf(GUEST_TASK_RUN);
    assert.ok(index > 0); assert.match(args[index + 1], /^[a-f0-9-]{36}$/);
    assert.equal(args[index + 2], '1200');
    assert.deepEqual(args.slice(index + 3), ['echo', '$(touch SHOULD_NOT_EXIST)', 'with spaces']);
    assert.equal(options?.input, 'literal stdin'); return 'ok';
  };
  assert.equal(await runtime.guest(environment(), ['echo', '$(touch SHOULD_NOT_EXIST)', 'with spaces'], { timeoutMs: 1200, input: 'literal stdin' }), 'ok');
});

test('cancelling a guest task waits for its separate scoped cancellation operation', async () => {
  const runtime = new LimaRuntime('/tmp/unused'), controller = new AbortController();
  let token = '', cancelled = false, release: (() => void) | undefined;
  runtime.command = async (args, options) => {
    if (args.includes(GUEST_TASK_CANCEL)) {
      assert.equal(args.at(-1), token); assert.equal(options?.signal, undefined);
      await new Promise<void>(resolve => { release = () => { cancelled = true; resolve(); }; }); return '';
    }
    token = args[args.indexOf(GUEST_TASK_RUN) + 1];
    controller.abort(); throw new AppError('cancelled', 409, 'CANCELLED');
  };
  let settled = false;
  const operation = runtime.guest(environment(), ['sleep', '30'], { signal: controller.signal }).finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release!(); await assert.rejects(operation, /cancelled/); assert.equal(cancelled, true);
});

test('guest timeout triggers remote cancellation and a pre-cancelled call starts nothing', async () => {
  const runtime = new LimaRuntime('/tmp/unused'); let calls = 0;
  runtime.command = async args => { calls++; if (args.includes(GUEST_TASK_CANCEL)) return ''; throw new AppError('timed out', 504, 'TIMEOUT'); };
  await assert.rejects(runtime.guest(environment(), ['sleep', '30']), /timed out/); assert.equal(calls, 2);
  await assert.rejects(runtime.guest(environment(), ['sleep', '30'], { signal: AbortSignal.abort() }), /取消/); assert.equal(calls, 2);
});
