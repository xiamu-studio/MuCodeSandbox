import json, os, pathlib, pwd, shutil, subprocess, sys, tempfile, time

# Disposable display and browser profile. Never inspect or attach user targets.
user = pwd.getpwnam('dev')
folder = tempfile.mkdtemp(prefix='mu-local-scroll-')
os.chown(folder, user.pw_uid, user.pw_gid)
display = chrome = None

def children(pid):
    result, pending = [], [pid]
    while pending:
        current = pending.pop()
        if current in result:
            continue
        result.append(current)
        try:
            pending += [int(v) for v in pathlib.Path('/proc', str(current), 'task', str(current), 'children').read_text().split()]
        except FileNotFoundError:
            pass
    return result

def stop_browser():
    global chrome
    if chrome:
        chrome.terminate()
        try:
            chrome.wait(5)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait()
        chrome = None

def inspect():
    rows, cpu = [], 0
    for pid in children(chrome.pid):
        proc = pathlib.Path('/proc', str(pid))
        try:
            stat = proc.joinpath('stat').read_text().rsplit(')', 1)[1].split()
            cpu += int(stat[11]) + int(stat[12])
            if proc.joinpath('exe').readlink().name != 'chrome':
                continue
            import shlex
            args = [v.decode() for v in proc.joinpath('cmdline').read_bytes().split(b'\0') if v]
            if len(args) == 1:
                args = shlex.split(args[0])
            role = next((v.split('=', 1)[1] for v in args if v.startswith('--type=')), 'browser')
            if role not in ('renderer', 'gpu-process'):
                continue
            threads = []
            for task in proc.joinpath('task').iterdir():
                try:
                    s = dict(v.split(':', 1) for v in task.joinpath('status').read_text().splitlines() if ':' in v)
                    threads.append(dict(tid=int(task.name), uid=int(s['Uid'].split()[0]), seccomp=int(s['Seccomp']), noNewPrivileges=int(s['NoNewPrivs']), effectiveCapabilities=s['CapEff'].strip()))
                except FileNotFoundError:
                    pass
            rows.append(dict(role=role, pid=pid, threads=threads, noSandboxFlag=any(v in args for v in ['--no-sandbox', '--disable-gpu-sandbox', '--disable-seccomp-filter-sandbox']), separatePidNamespace=proc.joinpath('ns/pid').readlink() != pathlib.Path('/proc/1/ns/pid').readlink()))
        except (FileNotFoundError, ProcessLookupError):
            pass
    memory = {k: int(v.split()[0]) for k, v in (line.split(':', 1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()) if k in ('MemTotal', 'MemAvailable')}
    display_ticks = 0
    for pid in children(display.pid):
        try:
            stat = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
            display_ticks += int(stat[11]) + int(stat[12])
        except FileNotFoundError:
            pass
    return dict(processes=rows, developmentUid=user.pw_uid, cpuSeconds=cpu/os.sysconf('SC_CLK_TCK'), displayCpuSeconds=display_ticks/os.sysconf('SC_CLK_TCK'), memoryKiB=memory)

try:
    if pathlib.Path('/tmp/.X97-lock').exists():
        raise RuntimeError('Diagnostic display already occupied')
    request = json.loads(sys.stdin.readline())
    import socket
    with socket.socket() as check_port:
        check_port.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check_port.bind(('127.0.0.1', 19223))
    auth = folder + '/Xauthority'
    pathlib.Path(auth).touch(mode=0o600)
    os.chown(auth, user.pw_uid, user.pw_gid)
    # xauth atomically replaces its file. Generate as the display user so the
    # replacement remains readable by Xvnc; a root-owned replacement can make
    # Xvnc ignore -auth and unintentionally accept local X11 clients.
    subprocess.run(['sudo', '-H', '-u', 'dev', '--', 'xauth', '-f', auth, 'add', ':97', '.', os.urandom(16).hex()], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert pathlib.Path(auth).stat().st_uid == user.pw_uid and pathlib.Path(auth).stat().st_mode & 0o777 == 0o600
    secret = folder + '/vnc'
    subprocess.run(['x11vnc', '-storepasswd', request['password'], secret], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chown(secret, user.pw_uid, user.pw_gid)
    os.chmod(secret, 0o600)
    log = open(folder + '/display.log', 'wb')
    fps, compare = request.get('fps', 45), request.get('compare', 2)
    if fps not in (45, 60) or compare not in (0, 2):
        raise ValueError('Invalid transport experiment')
    turbo = request.get('turboExecutable')
    turbo_rect_size = request.get('turboRectSize')
    turbo_combine = request.get('turboCombine')
    if turbo_rect_size is not None and (not turbo or turbo_rect_size not in (65536, 262144, 1048576, 4194304)):
        raise ValueError('Invalid isolated Tight rectangle size')
    if turbo_combine is not None and (not turbo or turbo_combine not in (1, 100)):
        raise ValueError('Invalid isolated Tight rectangle combine threshold')
    if turbo:
        import re
        binary = pathlib.Path(turbo)
        if not re.fullmatch(r'/tmp/mu-turbo-candidate\.[A-Za-z0-9]+/root/opt/TurboVNC/bin/Xvnc', turbo) or binary.stat().st_uid != 0 or binary.stat().st_mode & 0o6022:
            raise ValueError('Untrusted isolated TurboVNC executable')
        tuning = ['TVNC_MAXTIGHTRECTSIZE='+str(turbo_rect_size)] if turbo_rect_size is not None else []
        if turbo_combine is not None:
            tuning += ['TVNC_COMBINERECT='+str(turbo_combine)]
        tuning = ['env', *tuning] if tuning else []
        command = ['sudo', '-H', '-u', 'dev', '--', *tuning, turbo, ':97', '-geometry', str(request['width'])+'x'+str(request['height']), '-depth', '24', '-dpi', '192', '-nolisten', 'tcp', '-auth', auth, '-interface', '127.0.0.1', '-securitytypes', 'vnc', '-rfbauth', secret, '-rfbport', '15997', '-deferupdate', '1', '-nthreads', '4', '-noclipboardrecv', '-noclipboardsend', '-noprimarysync', '-dridir', '/usr/lib/aarch64-linux-gnu/dri']
    else:
        command = ['sudo', '-H', '-u', 'dev', '--', 'Xtigervnc', ':97', '-geometry', str(request['width'])+'x'+str(request['height']), '-depth', '24', '-dpi', '192', '-nolisten', 'tcp', '-auth', auth, '-interface', '127.0.0.1', '-localhost=1', '-UseIPv6=0', '-SecurityTypes', 'VncAuth', '-rfbauth', secret, '-rfbport', '15997', '-FrameRate='+str(fps), '-CompareFB='+str(compare)]
    display = subprocess.Popen(command, stdout=log, stderr=log)
    for _ in range(100):
        if pathlib.Path('/tmp/.X11-unix/X97').exists():
            break
        if display.poll() is not None:
            raise RuntimeError('Diagnostic display failed: '+pathlib.Path(folder+'/display.log').read_text()[-3000:])
        time.sleep(.1)
    with socket.create_connection(('127.0.0.1', 15997), timeout=1) as security:
        assert security.recv(12).startswith(b'RFB ')
        security.sendall(b'RFB 003.008\n')
        count = security.recv(1)[0]
        assert count > 0
        offered = security.recv(count)
        assert 1 not in offered and 2 in offered, 'Password authentication must remain required'
    security_report = {'passwordRequired': True}
    if request.get('functional'):
        import struct, ipaddress
        def receive_exact(connection, size):
            value = b''
            while len(value) < size:
                part = connection.recv(size-len(value))
                if not part:
                    raise RuntimeError('Short authentication response')
                value += part
            return value
        with socket.create_connection(('127.0.0.1', 15997), timeout=3) as negative:
            assert receive_exact(negative, 12) == b'RFB 003.008\n'
            negative.sendall(b'RFB 003.008\n')
            count = receive_exact(negative, 1)[0]
            assert 2 in receive_exact(negative, count)
            negative.sendall(b'\x02')
            receive_exact(negative, 16)
            negative.sendall(bytes(16))
            assert struct.unpack('!I', receive_exact(negative, 4))[0] != 0
        listeners = subprocess.check_output(['ss', '-ltnH', 'sport = :15997'], text=True).splitlines()
        assert listeners and all(ipaddress.ip_address(line.split()[3].rsplit(':', 1)[0].strip('[]')).is_loopback for line in listeners)
        assert not subprocess.check_output(['ss', '-ltnH', 'sport = :6097'], text=True).strip()
        denied = subprocess.run(['sudo', '-H', '-u', 'nobody', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'DISPLAY=:97', 'XAUTHORITY=/nonexistent', 'xdpyinfo'], capture_output=True)
        assert denied.returncode != 0
        security_report.update({'wrongPasswordDenied': True, 'loopbackVncOnly': True, 'xTcpDisabled': True, 'missingXAuthorityDenied': True})
    page = folder + '/fixture.html'
    pathlib.Path(page).write_text(request['html'])
    os.chmod(page, 0o644)
    print(json.dumps(dict(ready=True, pageUrl='file://'+page, cpus=os.cpu_count(), security=security_report)), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command.get('stop'):
            break
        if command.get('inspect'):
            print(json.dumps(inspect()), flush=True)
            continue
        if command.get('clipboardSeed'):
            subprocess.run(['sudo','-H','-u','dev','--','env','-i','PATH=/usr/bin:/bin','DISPLAY=:97','XAUTHORITY='+auth,'xclip','-selection','clipboard','-in'],input=b'MU_GUEST_CLIPBOARD_FIXTURE',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            print(json.dumps({'clipboardSeeded':True}),flush=True)
            continue
        if command.get('clipboardRead'):
            value=subprocess.check_output(['sudo','-H','-u','dev','--','env','-i','PATH=/usr/bin:/bin','DISPLAY=:97','XAUTHORITY='+auth,'xclip','-selection','clipboard','-out'],timeout=3).decode()
            print(json.dumps({'clipboard':value}),flush=True)
            continue
        stop_browser()
        variant = command['variant']
        if variant not in ('production', 'software-compositing'):
            raise ValueError('Invalid rendering experiment')
        profile = folder + '/profile-' + variant
        os.mkdir(profile)
        os.chown(profile, user.pw_uid, user.pw_gid)
        executable = request['executable']
        if not executable.startswith('/opt/mucodesandbox/chromium-') or not executable.endswith('/chrome-linux-arm64/chrome'):
            raise ValueError('Unexpected installed browser')
        args = ['sudo', '-H', '-u', 'dev', '--', 'env', '-i', 'HOME=/home/dev', 'USER=dev', 'PATH=/usr/local/bin:/usr/bin:/bin', 'DISPLAY=:97', 'XAUTHORITY='+auth, 'TZ=America/Los_Angeles', 'LANG=en_US.UTF-8', 'LP_NUM_THREADS=0', 'GALLIUM_DRIVER=llvmpipe', 'LIBGL_ALWAYS_SOFTWARE=1', 'MESA_SHADER_CACHE_DISABLE=true', 'CHROME_DEVEL_SANDBOX='+executable.rsplit('/', 1)[0]+'/chrome_sandbox', executable, '--user-data-dir='+profile, '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--disable-accelerated-2d-canvas', '--password-store=basic', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--mute-audio', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19223', '--force-device-scale-factor=2', '--window-position=0,0', '--window-size='+str(request['width']//2)+','+str(request['height']//2), '--lang=en-US']
        if variant == 'software-compositing':
            args += ['--disable-gpu-compositing']
        args += ['file://'+page]
        chrome = subprocess.Popen(args, stdout=open(folder+'/chrome.log', 'wb'), stderr=subprocess.STDOUT)
        import urllib.request
        for _ in range(100):
            try:
                with urllib.request.urlopen('http://127.0.0.1:19223/json/version', timeout=.5) as response:
                    json.load(response)
                break
            except Exception:
                if chrome.poll() is not None:
                    raise RuntimeError('Diagnostic browser failed')
                time.sleep(.1)
        print(json.dumps(dict(chromeReady=True, **inspect())), flush=True)
finally:
    stop_browser()
    if display:
        display.terminate()
        try:
            display.wait(3)
        except subprocess.TimeoutExpired:
            display.kill()
            display.wait()
    shutil.rmtree(folder, ignore_errors=True)
