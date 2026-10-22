import json
import os
import pathlib
import ssl
import sys
import urllib.request

directory, case_id = sys.argv[1:]
target = pathlib.Path(directory) / 'stream.json'
context = ssl.create_default_context(cafile='/etc/mucodesandbox/soak-ca.crt')
start = pathlib.Path('/proc/self/stat').read_text().split()[21]
sequence = -1
with urllib.request.urlopen('https://203.0.113.10/soak-stream', context=context, timeout=10) as response:
    while True:
        line = response.readline()
        if not line:
            raise RuntimeError('Persistent soak stream ended early')
        item = json.loads(line)
        if item['caseId'] != case_id or item['sequence'] != sequence + 1:
            raise RuntimeError('Persistent soak stream lost or reordered a record')
        sequence = item['sequence']
        temporary = target.with_suffix('.next')
        temporary.write_text(json.dumps(dict(pid=os.getpid(), start=start, sequence=sequence)))
        temporary.replace(target)
