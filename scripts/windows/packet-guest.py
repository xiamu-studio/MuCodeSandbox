"""Synthetic Ethernet observation/injection in new packet-lab guests only."""
import argparse
import json
import ipaddress
import os
import signal
import socket
import struct
import time


def mac(value):
    result = bytes.fromhex(value.replace(":", "").replace("-", ""))
    if len(result) != 6:
        raise ValueError("six-byte MAC required")
    return result


def checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 65535) + (total >> 16)
    return (~total) & 65535


def frames(source_mac, destination_mac, source_ip, nonce, phase, repeat):
    if len(nonce) != 64 or any(c not in "0123456789abcdef" for c in nonce):
        raise ValueError("nonce rejected")
    if phase not in ("startup", "approved", "control", "restored"):
        raise ValueError("phase rejected")
    result = []
    for family, kind, target in [(4, "tcp", str(ipaddress.IPv4Address(source_ip) - 1)),
                                 (4, "udp", "192.0.2.90"), (4, "icmp", "198.51.100.90"),
                                 (6, "tcp", "2001:db8::20"), (6, "udp", "2001:db8::21"),
                                 (6, "icmp", "2001:db8::22"), (0, "link", "")]:
        label = "%s-%s" % ("v%d" % family if family else "l2", kind)
        payload = ("MU_PKT|%s|%s|%s|%d|" % (nonce, phase, label, repeat)).encode("ascii")
        if family == 0:
            result.append((label, destination_mac + source_mac + struct.pack("!H", 0x88B5) + payload))
            continue
        source = socket.inet_pton(socket.AF_INET if family == 4 else socket.AF_INET6,
                                  source_ip if family == 4 else "2001:db8::10")
        destination = socket.inet_pton(socket.AF_INET if family == 4 else socket.AF_INET6, target)
        protocol = {"tcp": 6, "udp": 17, "icmp": 1 if family == 4 else 58}[kind]
        if kind == "tcp":
            segment = struct.pack("!HHIIBBHHH", 43210, 44444, 1, 0, 5 << 4, 2, 8192, 0, 0) + payload
            position = 16
        elif kind == "udp":
            segment = struct.pack("!HHHH", 43210, 44444, 8 + len(payload), 0) + payload
            position = 6
        else:
            segment = struct.pack("!BBHHH", 8 if family == 4 else 128, 0, 0, 1234, 1) + payload
            position = 2
        pseudo = b""
        if kind != "icmp" or family == 6:
            pseudo = source + destination + (struct.pack("!BBH", 0, protocol, len(segment)) if family == 4
                                              else struct.pack("!I3xB", len(segment), protocol))
        value = checksum(pseudo + segment)
        segment = segment[:position] + struct.pack("!H", value or 65535) + segment[position + 2:]
        if family == 4:
            header = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(segment), 1234, 0, 64, protocol, 0, source, destination)
            header = header[:10] + struct.pack("!H", checksum(header)) + header[12:]
        else:
            header = struct.pack("!IHBB16s16s", 6 << 28, len(segment), protocol, 64, source, destination)
        result.append((label, destination_mac + source_mac + struct.pack("!H", 0x0800 if family == 4 else 0x86DD) + header + segment))
    return result


def receive(source_mac):
    running = True
    def stop(_signum, _frame):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    counts = {"frames": 0, "ipv4": 0, "ipv6": 0, "tags": {}, "overflow": False, "socketDrops": 0, "socketPackets": 0}
    packet = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
    packet.bind(("eth0", 0)); packet.settimeout(0.1)
    def publish():
        received, dropped = struct.unpack("II", packet.getsockopt(263, 6, 8))
        counts["socketDrops"] += dropped; counts["socketPackets"] += received
        with open("/run/mu-packet-stats.next", "w") as output:
            json.dump(counts, output)
        os.replace("/run/mu-packet-stats.next", "/run/mu-packet-stats.json")
    with open("/run/mu-packet-receiver.pcap", "wb", buffering=0) as output:
        output.write(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 256, 1)); publish()
        while running:
            try:
                data = packet.recv(65536)
            except socket.timeout:
                continue
            if len(data) < 14 or data[6:12] != source_mac:
                continue
            counts["frames"] += 1
            kind = struct.unpack("!H", data[12:14])[0]
            counts["ipv4"] += kind == 0x0800; counts["ipv6"] += kind == 0x86DD
            mark = data.find(b"MU_PKT|")
            if mark >= 0:
                tag = data[mark:].decode("ascii", errors="replace")
                counts["tags"][tag] = counts["tags"].get(tag, 0) + 1
            stamp = time.time(); captured = data[:256]
            output.write(struct.pack("<IIII", int(stamp), int(stamp % 1 * 1000000), len(captured), len(data)) + captured)
            if output.tell() > 16 * 1024 * 1024:
                counts["overflow"] = True; break
            publish()
        os.fsync(output.fileno()); publish()
    packet.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("receive", "send")); parser.add_argument("--source-mac", required=True)
    parser.add_argument("--destination-mac"); parser.add_argument("--source-ip"); parser.add_argument("--nonce"); parser.add_argument("--phase")
    args = parser.parse_args()
    if args.mode == "receive":
        receive(mac(args.source_mac))
    else:
        actual = open("/sys/class/net/eth0/address").read().strip()
        if mac(actual) != mac(args.source_mac):
            raise ValueError("Guest adapter MAC mismatch")
        packet = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); packet.bind(("eth0", 0))
        for repeat in range(3):
            data = frames(mac(args.source_mac), mac(args.destination_mac), args.source_ip, args.nonce, args.phase, repeat)
            for label, frame in data:
                if packet.send(frame) != len(frame):
                    raise RuntimeError("Incomplete raw frame send")
                time.sleep(0.01)
        packet.close(); print(json.dumps({"frames": len(data) * 3, "labels": [label for label, _ in data]}))
