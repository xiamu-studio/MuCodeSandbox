// Independent AMD64 recipes. The Mac ARM64 release catalog remains unchanged.
// Chrome's digest was verified against Google's signed stable Release/Packages
// metadata and its published primary signing fingerprint.
export const WINDOWS_CHROME=Object.freeze({version:'155.0.8059.84',packageVersion:'155.0.8059.84-1',architecture:'amd64',
 sha256:'8fbd2ae69cdf7ee98b7513c3396a7b5e06f974f8625fdd590df3091dd0c3e9de',bytes:144080360,
 url:'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_155.0.8059.84-1_amd64.deb',
 signingFingerprint:'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796'});
export const WINDOWS_DISPLAY=Object.freeze({version:'3.3.1',architecture:'amd64',
 sha256:'5d99050312360a07c28aca484b944816aa32e9fe07912e3ed50e6bfda45f80ad',bytes:42893752,
 binarySha256:'4d4712903b68790108cd84a2fec9ea9db6f37a97fe015dd6f9528735c5345785',
 url:'https://github.com/TurboVNC/turbovnc/releases/download/3.3.1/turbovnc_3.3.1_amd64.deb'});
export const WINDOWS_CHROME_ROOT=`/opt/mucodesandbox/windows/chrome-${WINDOWS_CHROME.version}`;
export const WINDOWS_CHROME_EXECUTABLE=WINDOWS_CHROME_ROOT+'/chrome';
export const WINDOWS_DISPLAY_ROOT=`/opt/mucodesandbox/windows/turbovnc-${WINDOWS_DISPLAY.version}`;
export const WINDOWS_DISPLAY_EXECUTABLE=WINDOWS_DISPLAY_ROOT+'/bin/Xvnc';
