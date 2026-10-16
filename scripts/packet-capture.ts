import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function readPacketCapture(file: string, filter?: string) {
  const { stdout } = await execute('/usr/sbin/tcpdump', ['-nn', '-r', file, ...(filter ? [filter] : [])],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 2 ** 20 });
  return stdout;
}

export async function packetLines(file: string, filter: string) {
  return (await readPacketCapture(file, filter)).split('\n').filter(line => /^\d\d:\d\d:\d\d\./.test(line));
}
