import base64, errno, io, json, os, stat, sys, types
from unittest.mock import patch

request = json.load(sys.stdin)
program = request['script'].split("<<'MU_BROWSER_HOME'\n", 1)[1].rsplit('\nMU_BROWSER_HOME', 1)[0]
expected = base64.b64decode(request['content'])

for mode in ['same', 'changed', 'missing', 'owner', 'permissions', 'hardlink', 'symlink', 'unreadable', 'unsafe-parent']:
    events = []
    class File(io.BytesIO):
        def fileno(self): return 3
        def close(self):
            if self.fileno() == 3: events.append(('write', self.getvalue()))
            super().close()
    def open_file(name, flags, *args, **kwargs):
        if name == '/opt/mucodesandbox': return 1
        if name == 'browser-home.html':
            assert flags & os.O_NOFOLLOW
            assert flags & os.O_NONBLOCK
            if mode == 'missing': raise FileNotFoundError(errno.ENOENT, 'missing')
            if mode == 'symlink': raise OSError(errno.ELOOP, 'symlink')
            if mode == 'unreadable': raise PermissionError(errno.EACCES, 'unreadable')
            return 2
        assert name.startswith('.browser-home-') and flags & os.O_EXCL
        events.append(('create', name))
        return 3
    def fstat(fd):
        if fd == 1: return types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | (0o777 if mode == 'unsafe-parent' else 0o755))
        assert fd == 2
        return types.SimpleNamespace(st_uid=1000 if mode == 'owner' else 0,
            st_mode=stat.S_IFREG | (0o666 if mode == 'permissions' else 0o644),
            st_nlink=2 if mode == 'hardlink' else 1, st_size=len(expected))
    def fdopen(fd, access, **kwargs):
        if fd == 2:
            assert kwargs == {'closefd': False}
            return io.BytesIO((b'x' + expected[1:]) if mode == 'changed' else expected)
        assert fd == 3 and access == 'wb'
        return File()
    def replace(*args, **kwargs): events.append(('replace', args))
    def sync(fd): events.append(('sync', fd))
    def unlink(*args, **kwargs): raise FileNotFoundError()
    with patch.multiple(os, create=True, O_NOFOLLOW=0x20000, O_DIRECTORY=0x10000, O_NONBLOCK=0x800,
                        open=open_file, fstat=fstat, fdopen=fdopen, fchmod=lambda *a: None,
                        fsync=sync, replace=replace, close=lambda fd: None, unlink=unlink):
        try: exec(program, {})
        except (PermissionError, RuntimeError):
            assert mode in ['unreadable', 'unsafe-parent']
            assert not events
        else:
            assert mode not in ['unreadable', 'unsafe-parent']
            if mode == 'same': assert not events
            else:
                assert len([e for e in events if e[0] == 'replace']) == 1
                assert [e[1] for e in events if e[0] == 'write'] == [expected]
                assert len([e for e in events if e[0] == 'sync']) == 2
print('verified existing page reuse and atomic replacement boundaries')
