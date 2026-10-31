import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const builder = path.resolve('desktop/windows/builder.cjs');
const inspect = (signing: boolean) => {
  const env = { ...process.env };
  if (signing) env.MU_WINDOWS_SIGNING = '1'; else delete env.MU_WINDOWS_SIGNING;
  const result = spawnSync(process.execPath, ['-e', `const b=require(${JSON.stringify(builder)});process.stdout.write(JSON.stringify({forceCodeSigning:b.forceCodeSigning,signExecutable:b.win.signExecutable}));`], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('Windows preview packaging stays unsigned by default', () => {
  assert.deepEqual(inspect(false), { forceCodeSigning: false, signExecutable: false });
});

test('Windows signing mode explicitly enables forced signing', () => {
  assert.deepEqual(inspect(true), { forceCodeSigning: true, signExecutable: true });
});
