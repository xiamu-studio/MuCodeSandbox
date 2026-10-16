import { AppError } from './errors.ts';

export interface BrowserRelease { version: string; sha256: string; url: string; recipe: string; format: 'zip' | 'deb'; channel: 'testing' | 'stable'; packageVersion?: string }
function release(version: string, sha256: string): BrowserRelease {
  return Object.freeze({ version, sha256, recipe: `${version}:${sha256}:4`, format: 'zip' as const, channel: 'testing' as const,
    url: `https://cdn.playwright.dev/builds/cft/${version}/linux-arm64/chrome-linux-arm64.zip` });
}

// Official Playwright release metadata; archives are pinned after downloading over HTTPS.
export const APPROVED_BROWSER_RELEASES: readonly BrowserRelease[] = Object.freeze([
  release('153.0.8010.12', '7d8a4b4ff289efe44a06501a519df142c4c18fff7aaf1c1401a3fbb12b3bd069'),
  release('156.0.8078.4', '910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce'),
  // Google stable ARM64 repository. Retain the older testing recipes for recovery;
  // a lower stable version must never reuse a newer testing profile.
  Object.freeze({ version: '155.0.8059.39', packageVersion: '155.0.8059.39-1',
    sha256: '3556494580a71ecee15cbeb3b6ce23bf3af360bc053d90d3105241c2247da52b',
    recipe: '155.0.8059.39:3556494580a71ecee15cbeb3b6ce23bf3af360bc053d90d3105241c2247da52b:5',
    format: 'deb' as const, channel: 'stable' as const,
    url: 'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_155.0.8059.39-1_arm64.deb' }),
]);
export const CURRENT_BROWSER_RELEASE = APPROVED_BROWSER_RELEASES[2];
export function compareBrowserVersions(a: string, b: string) {
  if (![a,b].every(value => /^\d+(?:\.\d+){3}$/.test(value))) throw new Error('Invalid browser version');
  const left=a.split('.').map(Number), right=b.split('.').map(Number);
  for (let i=0;i<4;i++) if(left[i]!==right[i]) return left[i]>right[i]?1:-1;
  return 0;
}
export const browserExecutable = (release: BrowserRelease) => `/opt/mucodesandbox/chromium-${release.version}/chrome-linux-arm64/chrome`;
export function approvedBrowserRelease(version: string) {
  const release = APPROVED_BROWSER_RELEASES.find(item => item.version === version);
  if (!release) throw new AppError('这个浏览器版本尚未批准', 409, 'BROWSER_VERSION_UNAPPROVED');
  return release;
}
export function browserReleaseFromRecipe(recipe: string) {
  const release = APPROVED_BROWSER_RELEASES.find(item => item.recipe === recipe.trim());
  if (!release) throw new AppError('浏览器安装记录无法核验，请先修复', 409, 'BROWSER_RECIPE_UNAPPROVED');
  return release;
}
