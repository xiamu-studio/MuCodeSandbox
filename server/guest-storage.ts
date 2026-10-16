export const GUEST_ROOT_RESERVE_BYTES = 512 * 2 ** 20;

// Keep boot and management services writable when an ordinary task fills ext4.
export const CONFIGURE_GUEST_STORAGE_SCRIPT = `sudo python3 - <<'MU_STORAGE'
import grp, json, math, os, stat, subprocess
filesystem = json.loads(subprocess.check_output(['findmnt', '--json', '--output', 'SOURCE,FSTYPE,TARGET', '/']))['filesystems']
if len(filesystem) != 1 or filesystem[0]['target'] != '/' or filesystem[0]['fstype'] != 'ext4':
    raise RuntimeError('The supported guest root filesystem must be ext4')
device = os.path.realpath(filesystem[0]['source'])
if not device.startswith('/dev/') or not stat.S_ISBLK(os.stat(device).st_mode):
    raise RuntimeError('Guest root source must be a block device')
environment = dict(os.environ, LC_ALL='C', LANG='C')
def metadata():
    text = subprocess.check_output(['tune2fs', '-l', device], env=environment, text=True)
    return dict(line.split(':', 1) for line in text.splitlines() if ':' in line)
before = metadata()
block_size = int(before['Block size'])
blocks = int(before['Block count'])
required = math.ceil(${GUEST_ROOT_RESERVE_BYTES} / block_size)
if block_size <= 0 or required >= blocks // 2:
    raise RuntimeError('Guest disk is too small for the management reserve')
reserved = max(required, int(before['Reserved block count']))
try:
    capture_group = grp.getgrnam('tcpdump')
except KeyError:
    subprocess.run(['groupadd', '--system', 'tcpdump'], check=True)
    capture_group = grp.getgrnam('tcpdump')
if capture_group.gr_gid == 0 or capture_group.gr_mem:
    raise RuntimeError('Guest capture reserve group must be dedicated')
subprocess.run(['tune2fs', '-r', str(reserved), '-u', '0', '-g', str(capture_group.gr_gid), device], env=environment, check=True)
after = metadata()
if int(after['Reserved block count']) < required or int(after['Reserved blocks uid'].split()[0]) != 0 or int(after['Reserved blocks gid'].split()[0]) != capture_group.gr_gid:
    raise RuntimeError('Guest management reserve verification failed')
print(json.dumps({'rootStorageReserveBytes':int(after['Reserved block count'])*block_size,'rootStorageDevice':device,'captureReserveGid':capture_group.gr_gid}))
MU_STORAGE
`;
