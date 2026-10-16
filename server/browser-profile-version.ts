import { approvedBrowserRelease } from './browser-releases.ts';

// A final binary/profile compatibility gate, including explicit internal opens.
// Read user data with dev privileges and no-follow descriptors, never as root.
export function browserProfileCompatibilityScript(version: string) {
  approvedBrowserRelease(version);
  return `set -euo pipefail
sudo -H -u dev -- python3 - <<'MU_BROWSER_PROFILE_VERSION'
import os, re, stat
selected = tuple(map(int, ${JSON.stringify(version)}.split('.')))
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in ['home','dev','.local','share','mucodesandbox','browser']:
        try: next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        except FileNotFoundError: break
        os.close(fd); fd = next_fd
    else:
        try: record = os.open('Last Version', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError: record = None
        if record is not None:
            try:
                info = os.fstat(record)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 256: raise RuntimeError('Unsafe browser profile version record')
                value = os.read(record, 257).decode('ascii').strip()
                if not re.fullmatch(r'[0-9]+(?:\\.[0-9]+){3}', value): raise RuntimeError('Invalid browser profile version record')
                if tuple(map(int, value.split('.'))) > selected:
                    raise RuntimeError('Older browser cannot open a newer profile; create a fresh environment')
            finally: os.close(record)
finally: os.close(fd)
MU_BROWSER_PROFILE_VERSION
`;
}
