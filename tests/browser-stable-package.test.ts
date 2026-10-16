import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE, approvedBrowserRelease, browserExecutable, browserReleaseFromRecipe, compareBrowserVersions } from '../server/browser-releases.ts';
import { RECOVER_BROWSER_INSTALL_SCRIPT, browserInstallTransactionScript } from '../server/browser-install-transaction.ts';

const stable = CURRENT_BROWSER_RELEASE;
const installScript = () => browserInstallTransactionScript(stable.version, stable.recipe, '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb');
function pythonBody(script: string) {
  const match = script.match(/<<'MU_BROWSER_(?:INSTALL|RECOVER)'\n([\s\S]*)\nMU_BROWSER_(?:INSTALL|RECOVER)\n?$/);
  assert.ok(match, 'The generated script must contain one bounded Python heredoc');
  return match[1];
}
function compileOnly(script: string) {
  // compile validates syntax; it never executes the root installer or subprocesses.
  const checked = spawnSync('/usr/bin/python3', ['-c', 'import sys; compile(sys.stdin.read(), "guest-browser-script", "exec")'], { input: pythonBody(script), encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
}

test('the current release is the exact pinned official stable ARM64 Debian package', () => {
  assert.equal(stable.version, '155.0.8059.39');
  assert.equal(stable.packageVersion, '155.0.8059.39-1');
  assert.equal(stable.channel, 'stable'); assert.equal(stable.format, 'deb');
  assert.equal(stable.sha256, '3556494580a71ecee15cbeb3b6ce23bf3af360bc053d90d3105241c2247da52b');
  assert.equal(stable.recipe, `${stable.version}:${stable.sha256}:5`);
  assert.equal(stable.url, 'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_155.0.8059.39-1_arm64.deb');
  assert.equal(browserExecutable(stable), '/opt/mucodesandbox/chromium-155.0.8059.39/chrome-linux-arm64/chrome');
  assert.equal(approvedBrowserRelease(stable.version), stable);
  assert.equal(browserReleaseFromRecipe(`${stable.recipe}\n`), stable);
  assert.ok(Object.isFrozen(stable) && Object.isFrozen(APPROVED_BROWSER_RELEASES));
});

test('older testing recipes remain explicit ZIP releases and cannot be confused with a stable recipe', () => {
  const testing = APPROVED_BROWSER_RELEASES.filter(release => release.channel === 'testing');
  assert.equal(testing.length, 2);
  for (const release of testing) {
    assert.equal(release.format, 'zip');
    assert.equal(release.recipe, `${release.version}:${release.sha256}:4`);
    assert.match(release.url, /^https:\/\/cdn\.playwright\.dev\/builds\/cft\//);
    assert.equal(browserReleaseFromRecipe(release.recipe), release);
    const script = browserInstallTransactionScript(release.version, release.recipe, '/var/lib/mucodesandbox/browser-install/archive.zip', 'zip');
    assert.equal(browserInstallTransactionScript(release.version, release.recipe, '/var/lib/mucodesandbox/browser-install/archive.zip'), script);
    assert.ok(script.includes("subprocess.run(['unzip'"));
    assert.ok(!script.includes("subprocess.Popen(['dpkg-deb'"));
    compileOnly(script);
  }
  assert.throws(() => approvedBrowserRelease('154.0.0.1'), { code: 'BROWSER_VERSION_UNAPPROVED' });
  assert.throws(() => browserReleaseFromRecipe(stable.recipe.replace(stable.sha256, '0'.repeat(64))), { code: 'BROWSER_RECIPE_UNAPPROVED' });
  assert.throws(() => browserReleaseFromRecipe(stable.recipe.replace(/:5$/, ':4')), { code: 'BROWSER_RECIPE_UNAPPROVED' });
});

test('version comparison is numeric in all four components and detects the testing-to-stable downgrade', () => {
  assert.equal(compareBrowserVersions('155.0.8059.39', '156.0.8078.4'), -1);
  assert.equal(compareBrowserVersions('156.0.8078.4', '155.0.8059.39'), 1);
  assert.equal(compareBrowserVersions(stable.version, stable.version), 0);
  assert.equal(compareBrowserVersions('100.0.0.0', '99.99.99.99'), 1);
  assert.equal(compareBrowserVersions('155.1.0.0', '155.0.99999.0'), 1);
  assert.equal(compareBrowserVersions('155.0.10.0', '155.0.9.999'), 1);
  assert.equal(compareBrowserVersions('155.0.8059.100', '155.0.8059.99'), 1);
  for (const bad of ['155', '155.0.1', '155.0.1.2-1', '155.0.1.2\n', '155..1.2', 'a.0.1.2']) {
    assert.throws(() => compareBrowserVersions(bad, stable.version));
    assert.throws(() => compareBrowserVersions(stable.version, bad));
  }
});

test('Debian installation and recovery generate valid Python without executing privileged code', () => {
  const script = installScript();
  compileOnly(script); compileOnly(RECOVER_BROWSER_INSTALL_SCRIPT);
  assert.equal(browserInstallTransactionScript(stable.version, stable.recipe, '/var/lib/mucodesandbox/browser-install/archive.deb'), script);
  assert.ok(script.includes("subprocess.Popen(['dpkg-deb', '--fsys-tarfile'"));
  assert.ok(script.includes("parts[:3] != ('opt', 'google', 'chrome')"));
  assert.ok(script.includes("name.is_absolute() or '..' in name.parts"));
  assert.ok(script.includes("not (item.isfile() or item.isdir())"));
  assert.ok(script.includes('Duplicate browser payload path'));
  assert.ok(script.includes('total > 1024*1024*1024'));
  assert.ok(script.includes("(output / 'chrome-sandbox').rename(output / 'chrome_sandbox')"));
  assert.ok(script.includes(`!= "${stable.sha256}"`));
  assert.doesNotMatch(script, /\['dpkg',\s*['"](?:-i|--install)['"]|postinst|apt-get install|dpkg-deb.*--extract/);
});

test('archive format and staging-path validation reject traversal, substitution and shell text before script generation', () => {
  for (const archive of ['/tmp/archive.deb', '/var/lib/mucodesandbox/browser-install/archive.zip', '/var/lib/mucodesandbox/browser-install/../archive.deb', '/var/lib/mucodesandbox/browser-install/archive.deb;touch /tmp/unsafe', '/var/lib/mucodesandbox/browser-install/archive.deb\n']) {
    assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe, archive, 'deb'));
  }
  assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe, '/var/lib/mucodesandbox/browser-install/archive.deb', 'tar' as 'deb'));
  assert.throws(() => browserInstallTransactionScript('155.0.8059.39;exit', stable.recipe, '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'));
  assert.throws(() => browserInstallTransactionScript(stable.version, `156.0.8078.4:${stable.sha256}:5`, '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'));
  assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe.replace(stable.sha256, 'not-a-sha'), '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'));
});

test('script generation binds exact approved recipe hashes, recipe revisions and formats to the selected release', () => {
  assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe.replace(stable.sha256, '0'.repeat(64)), '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'), /not approved/);
  assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe.replace(/:5$/, ':4'), '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'), /not approved/);
  assert.throws(() => browserInstallTransactionScript(stable.version, stable.recipe, '/var/lib/mucodesandbox/browser-install/archive.zip', 'zip'), /not approved/);
  const older = APPROVED_BROWSER_RELEASES[0];
  assert.throws(() => browserInstallTransactionScript(older.version, older.recipe, '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'), /not approved/);
  assert.throws(() => browserInstallTransactionScript('154.0.0.1', `154.0.0.1:${'a'.repeat(64)}:5`, '/var/lib/mucodesandbox/browser-install/archive.deb', 'deb'), { code: 'BROWSER_VERSION_UNAPPROVED' });
});
