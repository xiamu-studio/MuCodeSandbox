"""Diagnostic only: extract the client CAB from Microsoft's official FoD ISO.

Requires pycdlib==1.16.0. No ISO is mounted and no host feature is installed.
Only the required HTTPS byte ranges are read; this is not whole-ISO verification.
The extracted CAB remains subject to Windows servicing's catalog verification.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request

import pycdlib

URL = ('https://software-static.download.prss.microsoft.com/dbazure/'
       '888969d5-f34g-4e03-ac9d-1f9786c66749/'
       '26100.1.240331-1435.ge_release_amd64fre_CLIENT_LOF_PACKAGES_OEM.iso')
SOURCE = 'https://learn.microsoft.com/en-us/azure/virtual-desktop/windows-11-language-packs'
ROOT = Path(__file__).resolve().parents[1] / '.mu-data/windows-clean-host-assets/fod-26100'
CLIENT = 'OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab'


class MicrosoftRanges(io.RawIOBase):
    """Read-only, bounded seekable input for the ISO metadata parser."""
    def __init__(self):
        self.position = 0
        self.length = None
        self.etag = None
        self.transferred = 0
        self.blocks = {}
        self.block_size = 1024 * 1024
        self._block(0)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        target = offset if whence == io.SEEK_SET else (
            self.position + offset if whence == io.SEEK_CUR else self.length + offset)
        if target < 0 or target > self.length:
            raise ValueError('ISO seek out of bounds')
        self.position = target
        return target

    def _block(self, number):
        if number in self.blocks:
            return self.blocks[number]
        start = number * self.block_size
        end = start + self.block_size - 1
        if self.length is not None:
            end = min(end, self.length - 1)
        if self.transferred + end - start + 1 > 256 * 1024 * 1024:
            raise ValueError('Diagnostic range transfer budget exceeded')
        headers = {'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'}
        if self.etag is not None:
            headers['If-Match'] = self.etag
        with urllib.request.urlopen(urllib.request.Request(URL, headers=headers), timeout=45) as r:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', r.headers.get('Content-Range', ''))
            if r.status != 206 or r.geturl() != URL or not match:
                raise ValueError('Expected exact HTTPS Microsoft range response')
            first, last, length = map(int, match.groups())
            if first != start or last != end or not 1024**3 < length < 16 * 1024**3:
                raise ValueError('ISO range/size changed')
            if self.length is not None and (length != self.length or r.headers.get('ETag') != self.etag):
                raise ValueError('ISO version changed during extraction')
            self.length, self.etag = length, r.headers.get('ETag')
            data = r.read(end - start + 2)
            if len(data) != end - start + 1:
                raise ValueError('Truncated or oversized range')
        self.transferred += len(data)
        self.blocks[number] = data
        print(f'FoD metadata/client ranges: {self.transferred // 1024} KiB', flush=True)
        return data

    def read(self, size=-1):
        if size < 0:
            size = self.length - self.position
        size = min(size, self.length - self.position)
        if size > 32 * 1024 * 1024:
            raise ValueError('Unexpected bulk ISO read')
        out = bytearray()
        while size:
            number, offset = divmod(self.position, self.block_size)
            data = self._block(number)
            count = min(size, len(data) - offset)
            out.extend(data[offset:offset + count])
            self.position += count
            size -= count
        return bytes(out)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    destination = ROOT / CLIENT
    if destination.exists() or (ROOT / 'source.json').exists():
        raise ValueError('Existing FoD evidence must be inspected, not overwritten')
    remote = MicrosoftRanges()
    iso = pycdlib.PyCdlib()
    iso.open_fp(remote)
    namespace = 'udf_path' if iso.has_udf() else 'joliet_path' if iso.has_joliet() else 'iso_path'
    matches = []
    for parent, _, names in iso.walk(**{namespace: '/'}):
        for name in names:
            if name.casefold().removesuffix(';1') == CLIENT.casefold():
                matches.append(parent.rstrip('/') + '/' + name)
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one x64 OpenSSH client CAB, got {len(matches)}')
    with destination.open('xb') as out:
        iso.get_file_from_iso_fp(out, **{namespace: matches[0]})
    iso.close()
    if not 1024 < destination.stat().st_size < 32 * 1024 * 1024:
        raise ValueError('Unexpected client CAB size')
    record = {'sourcePage': SOURCE, 'isoUrl': URL, 'isoSize': remote.length,
              'etag': remote.etag, 'isoPath': matches[0], 'rangeBytes': remote.transferred,
              'wholeIsoVerified': False, 'cab': CLIENT,
              'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
              'bytes': destination.stat().st_size,
              'trust': 'Microsoft HTTPS source; Windows catalog verification required before use'}
    (ROOT / 'source.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps(record), flush=True)


if __name__ == '__main__':
    main()
