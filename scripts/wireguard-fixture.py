import http.server
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/run/mu-wireguard-fixture')
CLIENT, GATEWAY, RECEIVER = 'mu-wg-client', 'mu-wg-gateway', 'mu-wg-receiver'
TARGET = '203.0.113.80'
processes = []
namespaces = []
report = {'passed': False, 'scope': 'Three isolated network namespaces in a real Linux VM; kernel WireGuard, routed NAT receiver. Not a deployed production mode or residential line.'}


def run(*args, namespace=None, input=None, timeout=15):
    command = (['ip', 'netns', 'exec', namespace] if namespace else []) + list(args)
    completed = subprocess.run(command, input=input, text=True, capture_output=True, timeout=timeout)
    if completed.returncode:
        # wg setconf input can contain a private key and must never be echoed.
        raise RuntimeError(f'{args[0]} failed ({completed.returncode}): {completed.stderr[-1000:]}')
    return completed.stdout


def start(*args, namespace):
    log = open(ROOT / ('process-' + str(len(processes)) + '.log'), 'wb')
    child = subprocess.Popen(['ip', 'netns', 'exec', namespace, *args], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    log.close()
    processes.append(child)
    return child


def curl(namespace, path, interface=None, source_port=None):
    args = ['curl', '--silent', '--fail', '--noproxy', '*', '--proxy', '', '--max-time', '2']
    if interface:
        args += ['--interface', interface]
    if source_port:
        args += ['--local-port', str(source_port)]
    return run(*args, f'http://{TARGET}:8080/{path}', namespace=namespace, timeout=4)


def rejected(call):
    try:
        call()
    except (RuntimeError, subprocess.TimeoutExpired):
        return
    raise AssertionError('A forbidden connection succeeded')


def stop(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGINT)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)


def packets(filename):
    raw = (ROOT / filename).read_bytes()
    endian = '<' if raw[:4] == b'\xd4\xc3\xb2\xa1' else '>' if raw[:4] == b'\xa1\xb2\xc3\xd4' else None
    assert endian, 'Expected a complete microsecond PCAP'
    link = struct.unpack(endian + 'I', raw[20:24])[0]
    offset = 24
    result = []
    while offset < len(raw):
        assert offset + 16 <= len(raw), 'Truncated PCAP record'
        size = struct.unpack(endian + 'IIII', raw[offset:offset + 16])[2]
        offset += 16
        data = raw[offset:offset + size]
        assert len(data) == size
        offset += size
        if link == 1:
            assert data[12:14] == b'\x08\x00', 'Unexpected non-IPv4 capture'
            data = data[14:]
        elif link in (12, 101):
            pass
        else:
            raise AssertionError(f'Unsupported capture link type {link}')
        assert len(data) >= 20 and data[0] >> 4 == 4
        result.append(data)
    return result


def syn(packet):
    offset = (packet[0] & 15) * 4
    return packet[9] == 6 and len(packet) >= offset + 20 and packet[offset + 13] & 0x12 == 0x02


def compare_syn(before, after):
    assert any(syn(packet) for packet in before), 'Client SYN capture is empty'
    assert any(syn(packet) for packet in after), 'Receiver SYN capture is empty'
    a, b = next(p for p in before if syn(p)), next(p for p in after if syn(p))
    ai, bi = (a[0] & 15) * 4, (b[0] & 15) * 4
    at, bt = bytearray(a[ai:]), bytearray(b[bi:])
    # IPv4 NAT updates the TCP checksum; all other TCP bytes must survive.
    at[16:18] = bt[16:18] = b'\x00\x00'
    assert at == bt, 'TCP SYN was modified or a connection was recreated'
    assert a[16:20] == b[16:20]
    assert a[12:16] != b[12:16], 'The positive NAT test did not change source IP'
    assert a[8] == b[8] + 1, 'Expected exactly one routing hop'
    assert a[0:8] == b[0:8], 'IPv4 fields other than TTL, checksum and source changed'
    return {'tcpBytesPreservedExceptNatChecksum': True, 'sourceBeforeNat': socket.inet_ntoa(a[12:16]), 'sourceAfterNat': socket.inet_ntoa(b[12:16]), 'destination': socket.inet_ntoa(a[16:20]), 'ttlBefore': a[8], 'ttlAfter': b[8], 'sequence': struct.unpack('!I', at[4:8])[0], 'window': struct.unpack('!H', at[14:16])[0], 'tcpOptionsHex': bytes(at[20:(at[12] >> 4) * 4]).hex()}


def main():
    secret_stat = (ROOT / 'config.json').stat()
    assert secret_stat.st_uid == 0 and secret_stat.st_mode & 0o777 == 0o600
    report['rootOnlySecretFile'] = True
    config = json.loads((ROOT / 'config.json').read_text())
    report['kernel'] = run('uname', '-r').strip()
    report['wireguardTools'] = run('wg', '--version').strip()
    report['captureTool'] = run('tcpdump', '--version').strip().split('\n')[0]
    for name in (CLIENT, GATEWAY, RECEIVER):
        run('ip', 'netns', 'add', name)
        namespaces.append(name)
        run('ip', 'link', 'set', 'lo', 'up', namespace=name)
    for left, right, left_ns, right_ns in [('wgc', 'wgg', CLIENT, GATEWAY), ('wgs', 'wgr', GATEWAY, RECEIVER)]:
        run('ip', 'link', 'add', left, 'type', 'veth', 'peer', 'name', right)
        run('ip', 'link', 'set', left, 'netns', left_ns)
        run('ip', 'link', 'set', right, 'netns', right_ns)
    for name, interface, address in [(CLIENT, 'wgc', '192.0.2.2/30'), (GATEWAY, 'wgg', '192.0.2.1/30'), (GATEWAY, 'wgs', '192.0.2.129/30'), (RECEIVER, 'wgr', '192.0.2.130/30')]:
        run('ip', 'addr', 'add', address, 'dev', interface, namespace=name)
        run('ip', 'link', 'set', interface, 'up', namespace=name)
    run('ip', 'addr', 'add', TARGET + '/32', 'dev', 'lo', namespace=RECEIVER)
    run('ip', 'route', 'add', TARGET + '/32', 'via', '192.0.2.130', namespace=GATEWAY)
    run('ip', 'route', 'add', 'default', 'via', '192.0.2.129', namespace=RECEIVER)
    run('sysctl', '-qw', 'net.ipv4.ip_forward=1', namespace=GATEWAY)
    run('nft', '-f', '-', namespace=GATEWAY, input='''table ip mu_nat {
  chain postrouting {
    type nat hook postrouting priority srcnat;
    oifname "wgs" masquerade
  }
}
''')
    server = "import http.server\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'MU_WIREGUARD_OK')\n def log_message(self,*args): pass\nhttp.server.HTTPServer(('203.0.113.80',8080),Handler).serve_forever()"
    start('python3', '-u', '-c', server, namespace=RECEIVER)
    time.sleep(0.3)
    run('ip', 'route', 'add', TARGET + '/32', 'via', '192.0.2.1', namespace=CLIENT)
    assert curl(CLIENT, 'direct-positive-control') == 'MU_WIREGUARD_OK'
    report['directRoutePositiveControl'] = True
    run('ip', 'route', 'del', TARGET + '/32', namespace=CLIENT)
    for namespace, address, text in [(CLIENT, '10.77.0.2/32', config['client']), (GATEWAY, '10.77.0.1/32', config['gateway'])]:
        run('ip', 'link', 'add', 'mu_wg', 'type', 'wireguard', namespace=namespace)
        run('wg', 'setconf', 'mu_wg', '/dev/stdin', input=text, namespace=namespace)
        run('ip', 'addr', 'add', address, 'dev', 'mu_wg', namespace=namespace)
        run('ip', 'link', 'set', 'mu_wg', 'mtu', '1420', 'up', namespace=namespace)
    assert run('wg', 'show', 'mu_wg', 'public-key', namespace=CLIENT).strip() == config['clientPublicKey']
    run('ip', 'route', 'add', 'default', 'dev', 'mu_wg', namespace=CLIENT)
    run('ip', 'route', 'add', '10.77.0.2/32', 'dev', 'mu_wg', namespace=GATEWAY)
    run('nft', '--check', '-f', '-', input=config['firewall'], namespace=CLIENT)
    run('nft', '-f', '-', input=config['firewall'], namespace=CLIENT)
    captures = [
        start('tcpdump', '--immediate-mode', '-ni', 'mu_wg', '-Q', 'out', '-U', '-w', str(ROOT / 'client.pcap'), f'tcp dst port 8080 and dst host {TARGET}', namespace=CLIENT),
        start('tcpdump', '--immediate-mode', '-ni', 'wgr', '-Q', 'in', '-U', '-w', str(ROOT / 'receiver.pcap'), f'tcp dst port 8080 and dst host {TARGET}', namespace=RECEIVER),
        start('tcpdump', '--immediate-mode', '-ni', 'wgc', '-Q', 'out', '-U', '-w', str(ROOT / 'transport.pcap'), 'ip or ip6', namespace=CLIENT),
    ]
    time.sleep(0.5)
    assert all(child.poll() is None for child in captures)
    assert curl(CLIENT, 'protected', source_port=40000) == 'MU_WIREGUARD_OK'
    handshake = run('wg', 'show', 'mu_wg', 'latest-handshakes', namespace=CLIENT).split()
    assert len(handshake) == 2 and int(handshake[1]) > 0
    report['actualKernelHandshakeAndHttp'] = True
    for capture in captures[:2]:
        stop(capture)
    report['synComparison'] = compare_syn(packets('client.pcap'), packets('receiver.pcap'))
    run('ip', 'route', 'add', TARGET + '/32', 'via', '192.0.2.1', namespace=CLIENT)
    rejected(lambda: curl(CLIENT, 'physical-bypass', interface='wgc'))
    run('ip', 'route', 'del', TARGET + '/32', namespace=CLIENT)
    report['directRouteBypassBlocked'] = True
    run('wg', 'setconf', 'mu_wg', '/dev/stdin', input=config['wrongPeer'], namespace=CLIENT)
    rejected(lambda: curl(CLIENT, 'wrong-peer'))
    report['wrongPeerHasNoFallback'] = True
    run('wg', 'setconf', 'mu_wg', '/dev/stdin', input=config['client'], namespace=CLIENT)
    assert curl(CLIENT, 'peer-restored') == 'MU_WIREGUARD_OK'
    report['peerRecovery'] = True
    run('ip', 'link', 'set', 'mu_wg', 'down', namespace=CLIENT)
    rejected(lambda: curl(CLIENT, 'tunnel-down'))
    run('ip', 'route', 'add', TARGET + '/32', 'via', '192.0.2.1', namespace=CLIENT)
    rejected(lambda: curl(CLIENT, 'tunnel-down-physical-bypass', interface='wgc'))
    report['tunnelLossAndAlternateRouteHaveNoFallback'] = True
    blocked = json.loads(run('nft', '-j', 'list', 'counter', 'inet', 'mu_wg_fixture', 'blocked', namespace=CLIENT))
    report['blockedPackets'] = next(item['counter']['packets'] for item in blocked['nftables'] if 'counter' in item)
    assert report['blockedPackets'] > 0
    stop(captures[2])
    transport = packets('transport.pcap')
    assert transport, 'No encrypted transport positive control'
    for packet in transport:
        assert packet[9] == 17, 'Non-UDP packet escaped onto the underlay'
        offset = (packet[0] & 15) * 4
        assert socket.inet_ntoa(packet[16:20]) == '192.0.2.1'
        assert struct.unpack('!H', packet[offset + 2:offset + 4])[0] == 51820
        assert b'GET /' not in packet and b'MU_WIREGUARD_OK' not in packet
    report['underlayOnlyApprovedWireguardUdp'] = {'packets': len(transport), 'plaintextHttpAbsent': True, 'scope': 'isolated namespace veth, not VM eth0 or a public line'}
    report['passed'] = True


try:
    assert os.geteuid() == 0
    main()
except Exception as error:
    report['error'] = repr(error)
finally:
    for process in reversed(processes):
        stop(process)
    for namespace in reversed(namespaces):
        try:
            run('ip', 'netns', 'del', namespace)
        except Exception as error:
            report.setdefault('cleanupErrors', []).append(str(error))
            report['passed'] = False
    report['captureDiagnostics'] = [log.read_text()[-1500:] for log in sorted(ROOT.glob('process-*.log'))]
    (ROOT / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
sys.exit(0 if report['passed'] else 1)
