"""Windows test adapter for Linux renameat2(RENAME_NOREPLACE), not product code.

Retry only local Windows sharing/access denials for at most 500 ms. Preserve
source identity and destination exclusivity throughout that bounded interval.
"""
import os
import pathlib
import time


def exclusive_rename(source, destination, expected_identity=None):
    source = pathlib.Path(source)
    destination = pathlib.Path(destination)
    original = os.lstat(source)
    identity = (original.st_dev, original.st_ino)
    if expected_identity is not None and identity != expected_identity:
        raise RuntimeError('Rename adapter source changed')
    deadline = time.monotonic() + 0.5
    while True:
        if os.path.lexists(destination):
            raise FileExistsError(str(destination))
        current = os.lstat(source)
        if (current.st_dev, current.st_ino) != identity:
            raise RuntimeError('Rename adapter source changed')
        try:
            os.rename(source, destination)
            return
        except PermissionError as error:
            if os.name != 'nt' or getattr(error, 'winerror', None) not in (5, 32, 33) or time.monotonic() >= deadline:
                raise
            time.sleep(0.01)
