"""Fixed, read-only inspection of the identity-bound failed Pro Linux disk."""
import hashlib
import json
import os
import re
import sys
import stat
import logging
from types import SimpleNamespace
from datetime import datetime, timezone
from pathlib import Path

from dissect.extfs import ExtFS
from dissect.hypervisor.disk.vhdx import VHDX
from dissect.volume.disk import Disk
from dissect.target.plugins.os.unix.log.journal import JournalFile

case = sys.argv[1]
assert os.environ.get("COMPUTERNAME") == "MU-PRO-LAB"
assert re.fullmatch("[a-f0-9]{32}", case)
cfg = json.loads(Path(f"C:/MuLab/approved/volume-{case}-offline.json").read_text("utf8"))
assert cfg["caseId"] == case
assert re.fullmatch(r"S-1-5-21-(?:\d+-){3}\d+", cfg["userSid"])
assert re.fullmatch(r"[a-f0-9-]{36}", cfg["id"])
expected = f"C:/ProgramData/MuCodeSandbox-HyperVBroker-v1/users/{cfg['userSid']}/vms/{cfg['id']}/disk.vhdx"
assert cfg["disk"].replace("\\", "/").casefold() == expected.casefold()
result = {"caseId": case, "readOnly": True, "files": {}, "roots": []}
with open(cfg["disk"], "rb") as source:
    disk = VHDX(source)
    assert not disk.has_parent
    roots = []
    for partition in Disk(disk).partitions:
        try:
            fs = ExtFS(partition.open())
            fs.get("/etc/os-release")
            roots.append((partition, fs))
        except Exception:
            pass
    assert len(roots) == 1
    partition, fs = roots[0]
    result["rootOffset"] = partition.offset
    result["managementMetadata"] = []
    for name in ["/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_ed25519_key.pub", "/home/mu/.ssh/authorized_keys", "/etc/systemd/system/multi-user.target.wants/mu-hv-ssh.service", "/etc/systemd/system/sockets.target.wants/ssh.socket", "/workspace/volume-canary-" + case + ".txt", "/var/lib/cloud/instances/" + cfg["id"] + "/network-config.json"]:
        try:
            node = fs.get(name)
            with node.open() as stream:
                data = stream.read(65536)
            result["managementMetadata"].append({"path": name, "bytes": node.size, "mode": oct(node.inode.i_mode & 0o7777), "sha256": hashlib.sha256(data).hexdigest(), "symlink": node.filetype == stat.S_IFLNK})
        except Exception as error:
            result["managementMetadata"].append({"path": name, "error": str(error)})
    for folder in ["/etc/systemd/system/ssh.socket.d", "/etc/ssh/sshd_config.d", "/var/log", "/var/log/journal"]:
        try:
            result["roots"].append({"path": folder, "entries": [entry.filename for entry in fs.get(folder).iterdir()]})
        except Exception as error:
            result["roots"].append({"path": folder, "error": type(error).__name__})
    paths = ["/etc/os-release", "/etc/systemd/system/mu-hv-ssh.service", "/usr/local/libexec/mu-hv-ssh", "/usr/lib/systemd/system/ssh.socket", "/etc/systemd/system/ssh.socket.d/addresses.conf", "/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d/90-mucodesandbox.conf", "/var/log/syslog", "/var/log/auth.log", "/var/log/cloud-init-output.log", "/var/log/cloud-init.log", "/var/lib/cloud/data/status.json", "/var/lib/cloud/data/result.json", "/var/lib/cloud/instance/network-config.json"]
    for name in paths:
        try:
            node = fs.get(name)
            with node.open() as stream:
                if name.startswith("/var/log/"):
                    stream.seek(max(0, node.size - 16 * 1024 * 1024))
                data = stream.read(16 * 1024 * 1024)
            text = data.decode("utf8", "replace")
            if name.startswith("/var/log/") and name != "/var/log/cloud-init-output.log":
                text = "\n".join(line for line in text.splitlines() if re.search("ssh|vsock|hv_sock|failed|error|socket|bind", line, re.I))[-48000:]
            result["files"][name] = {"sha256": hashlib.sha256(data).hexdigest(), "text": text, "bytes": node.size}
        except Exception as error:
            result["files"][name] = {"error": type(error).__name__ + ": " + str(error)}
    journals = []
    for folder in fs.get("/var/log/journal").iterdir():
        if folder.filename in [".", ".."] or folder.filetype != stat.S_IFDIR:
            continue
        for node in folder.iterdir():
            if node.filename.endswith((".journal", ".journal~")) and node.size < 128 * 1024 * 1024:
                journals.append((node.mtime_ns, folder.filename + "/" + node.filename, node))
    result["journal"] = []
    result["journalFiles"] = []
    target = SimpleNamespace(log=logging.getLogger("readonly-journal"))
    for _, name, node in sorted(journals, reverse=True, key=lambda item: item[0])[:8]:
        result["journalFiles"].append({"name": name, "bytes": node.size})
        try:
            with node.open() as stream:
                for number, event in enumerate(JournalFile(stream, target)):
                    if number > 100000:
                        break
                    if event["ts"].date() != datetime.now(timezone.utc).date():
                        continue
                    message = str(event.get("message", ""))
                    if re.search("ssh|cloud-init|mu-hv|vsock|hv_sock|bind|failed", message, re.I):
                        result["journal"].append({"at": event["ts"].isoformat(), "message": message, "unit": event.get("systemd_unit", "")})
        except Exception as error:
            result["journalFiles"][-1]["error"] = str(error)
    result["journal"] = result["journal"][-600:]
Path(f"C:/MuLab/approved/volume-{case}-offline-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), "utf8")
print(json.dumps({"complete": True, "readOnly": True, "files": len(result["files"])}))
