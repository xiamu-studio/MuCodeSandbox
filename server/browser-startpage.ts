import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { usesBrowserHome } from '../shared/browser-home.ts';
export const GUEST_HOME_URL='file:///opt/mucodesandbox/browser-home.html';
export function browserHomePath(){return path.resolve(import.meta.dirname,import.meta.filename.endsWith('.ts')?'../desktop/browser-home.html':'../../desktop/browser-home.html');}
export function localBrowserStartUrl(url:string){return usesBrowserHome(url)?pathToFileURL(browserHomePath()).href:url;}
export function guestBrowserStartUrl(url:string){return usesBrowserHome(url)?GUEST_HOME_URL:url;}
export async function browserHomeInstallScript(reuseVerified=false){
  const content=(await readFile(browserHomePath())).toString('base64');
  return `sudo /usr/bin/python3 -I - <<'MU_BROWSER_HOME'
import base64, os, secrets, stat, errno
expected = base64.b64decode('${content}', validate=True)
parent = os.open('/opt/mucodesandbox', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
temp = '.browser-home-' + secrets.token_hex(8)
try:
    s = os.fstat(parent)
    if s.st_uid != 0 or stat.S_IMODE(s.st_mode) & 0o022:
        raise RuntimeError('Browser home directory is not protected')
    unchanged = False
${reuseVerified?`    try:
        existing = os.open('browser-home.html', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ELOOP): raise
    else:
        try:
            info = os.fstat(existing)
            if stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o644 and info.st_nlink == 1 and info.st_size == len(expected):
                with os.fdopen(existing, 'rb', closefd=False) as source:
                    unchanged = source.read(len(expected) + 1) == expected
        finally:
            os.close(existing)
`:''}    if not unchanged:
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        with os.fdopen(fd, 'wb') as f:
            f.write(expected)
            f.flush()
            os.fchmod(f.fileno(), 0o644)
            os.fsync(f.fileno())
        os.replace(temp, 'browser-home.html', src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
finally:
    try: os.unlink(temp, dir_fd=parent)
    except FileNotFoundError: pass
    os.close(parent)
MU_BROWSER_HOME
`;
}
