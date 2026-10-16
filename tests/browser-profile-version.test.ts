import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { browserProfileCompatibilityScript } from '../server/browser-profile-version.ts';

const parts = ['home', 'dev', '.local', 'share', 'mucodesandbox', 'browser'];
const selected = CURRENT_BROWSER_RELEASE.version;
async function fixture(check: (root: string, profile: string) => Promise<void>, createProfile = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-profile-version-'));
  const profile = path.join(root, ...parts);
  try {
    if (createProfile) await mkdir(profile, { recursive: true, mode: 0o700 });
    await check(root, profile);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function checkProfile(root: string, version = selected, timeout = 2000) {
  const generated = browserProfileCompatibilityScript(version);
  const match = generated.match(/<<'MU_BROWSER_PROFILE_VERSION'\n([\s\S]*)\nMU_BROWSER_PROFILE_VERSION\n?$/);
  assert.ok(match, 'Generated compatibility gate must use a bounded Python heredoc');
  const original = "fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)";
  assert.equal(match[1].split(original).length, 2, 'Only the initial root descriptor may be substituted');
  const source = match[1].replace(original, `fd = os.open(${JSON.stringify(root)}, os.O_RDONLY | os.O_DIRECTORY)`);
  // Execute just the Python body, as the current ordinary user, within a temp root.
  // The shell wrapper (including sudo) is never executed in these fixtures.
  return spawnSync('/usr/bin/python3', ['-'], { input: source, encoding: 'utf8', timeout });
}
function accepted(result: ReturnType<typeof checkProfile>) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function rejected(result: ReturnType<typeof checkProfile>, message?: RegExp) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'Unsafe/incompatible profile was accepted');
  if (message) assert.match(result.stderr, message);
}

test('unknown binary versions fail before a guest profile script is generated', () => {
  assert.throws(() => browserProfileCompatibilityScript('154.0.0.1'), { code: 'BROWSER_VERSION_UNAPPROVED' });
  assert.throws(() => browserProfileCompatibilityScript(`${selected};touch /tmp/unsafe`));
});

test('a missing profile hierarchy or an empty profile without Last Version is accepted without creating files', async () => {
  await fixture(async root => {
    accepted(checkProfile(root)); assert.deepEqual(await readdir(root), []);
  }, false);
  await fixture(async (root, profile) => {
    accepted(checkProfile(root)); assert.deepEqual(await readdir(profile), []);
  });
});

test('equal and older four-part versions are accepted and their records remain byte-for-byte unchanged', async () => {
  await fixture(async (root, profile) => {
    const record = path.join(profile, 'Last Version');
    for (const version of [selected, '153.0.8010.12', '155.0.8059.38', '99.999.999.999']) {
      const content = `${version}\n`; await writeFile(record, content);
      const before = await stat(record);
      accepted(checkProfile(root));
      assert.equal(await readFile(record, 'utf8'), content);
      const after = await stat(record); assert.equal(after.mtimeMs, before.mtimeMs);
    }
  });
});

test('newer profile versions reject downgrade access without changing user files', async () => {
  await fixture(async (root, profile) => {
    const record = path.join(profile, 'Last Version');
    for (const version of ['156.0.8078.4', '155.0.8059.40', '155.1.0.0', '1000.0.0.0']) {
      await writeFile(record, `${version}\n`);
      rejected(checkProfile(root), /Older browser cannot open a newer profile/);
      assert.equal(await readFile(record, 'utf8'), `${version}\n`);
    }
  });
});

test('empty, malformed, non-ASCII and oversized existing version records are rejected', async () => {
  await fixture(async (root, profile) => {
    const record = path.join(profile, 'Last Version');
    for (const content of ['', '155', '155.0.1', '155.0.1.2-1', '155..1.2', 'a.0.1.2', '155.0.1.2\n156.0.1.2', '155.0.1.2\0', '1'.repeat(257), Buffer.from([255, 254])]) {
      await writeFile(record, content);
      rejected(checkProfile(root));
      assert.deepEqual(await readFile(record), Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
  });
});

test('Last Version symlinks, including dangling ones, are refused instead of following their targets', async () => {
  await fixture(async (root, profile) => {
    const target = path.join(root, 'external-version');
    await writeFile(target, '153.0.8010.12\n');
    const record = path.join(profile, 'Last Version');
    await symlink(target, record);
    rejected(checkProfile(root));
    assert.equal(await readFile(target, 'utf8'), '153.0.8010.12\n');
    await rm(target); rejected(checkProfile(root));
  });
});

test('symlinked ancestors are refused at every level of the profile path', async () => {
  for (let count = 1; count <= parts.length; count++) {
    await fixture(async (root, profile) => {
      await writeFile(path.join(profile, 'Last Version'), '153.0.8010.12\n');
      const original = path.join(root, ...parts.slice(0, count));
      const moved = path.join(root, 'external-profile');
      await rename(original, moved); await symlink(moved, original, 'dir');
      rejected(checkProfile(root));
      assert.equal(await readFile(path.join(moved, ...parts.slice(count), 'Last Version'), 'utf8'), '153.0.8010.12\n');
    });
  }
});

test('non-directory ancestors and directory version records are rejected', async () => {
  await fixture(async (root, profile) => {
    await mkdir(path.join(profile, 'Last Version')); rejected(checkProfile(root), /Unsafe browser profile version record/);
  });
  await fixture(async (root, profile) => {
    const parent = path.join(root, 'home/dev/.local');
    await rm(parent, { recursive: true }); await writeFile(parent, 'not a directory');
    rejected(checkProfile(root));
    assert.equal(await readFile(parent, 'utf8'), 'not a directory');
  });
});

test('a FIFO record is rejected promptly without waiting for a writer', async () => {
  await fixture(async (root, profile) => {
    const created = spawnSync('/usr/bin/python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1])', path.join(profile, 'Last Version')], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const started = performance.now();
    rejected(checkProfile(root, selected, 1500), /Unsafe browser profile version record/);
    assert.ok(performance.now() - started < 1500, 'FIFO rejection must not depend on the management timeout');
  });
});

test('generated path traversal reads through no-follow directory descriptors with development privileges', () => {
  const source = browserProfileCompatibilityScript(selected);
  assert.ok(source.includes('sudo -H -u dev -- python3'));
  assert.ok(source.includes('os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd'));
  assert.ok(source.includes("os.open('Last Version',"));
  assert.ok(source.includes('os.fstat(record)'));
  assert.doesNotMatch(source, /os\.replace|os\.rename|os\.unlink|chmod|chown|open\([^\n]*['"]w['"]|sudo python3/);
});
