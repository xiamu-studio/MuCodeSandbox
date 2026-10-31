import {AppError} from '../../errors.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';

// The existing base remains the active default. A release becoming a verified
// preparation candidate does not select it or authorize profile adoption.
export const WINDOWS_BROWSER_CANDIDATE=Object.freeze({
 version:'156.0.8078.47',packageVersion:'156.0.8078.47-1',architecture:'amd64',
 sha256:'6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8',bytes:144849192,
 binarySha256:'95dc9473b4f904cb3ab0800fc7206081fcae12abc094a088bd741a13f1747b72',
 sandboxSha256:'be9f5d4be90fa60b985ad3069812b144ba7331fed0c3f980c6d9399d37d60314',
 url:'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.47-1_amd64.deb',
 signingFingerprint:WINDOWS_CHROME.signingFingerprint,
});
export const WINDOWS_BROWSER_RELEASES=Object.freeze([WINDOWS_CHROME,WINDOWS_BROWSER_CANDIDATE]);
export function approvedWindowsBrowserRelease(version:string){
 const value=WINDOWS_BROWSER_RELEASES.find(release=>release.version===version);
 if(!value)throw new AppError('这个 Linux AMD64 浏览器版本尚未批准',409,'BROWSER_VERSION_UNAPPROVED');
 return value;
}
export function windowsBrowserReleaseRoot(version:string){return '/opt/mucodesandbox/windows/chrome-'+approvedWindowsBrowserRelease(version).version;}
