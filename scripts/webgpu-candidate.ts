import assert from 'node:assert/strict';
import { GUEST_BROWSER_SERVICE } from '../server/guest-browser-runtime.ts';
import type { LimaRuntime } from '../server/runtime.ts';

export const GRAPHITE_CANDIDATE_FLAGS = ['--disable-dawn-features=adapter_blocklist', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--enable-skia-graphite', '--skia-graphite-dawn-backend=swiftshader'];

// The normal launcher and navigation-before-sandbox check still run in the guest.
export function installGraphiteCandidate(runtime: LimaRuntime) {
  const original = runtime.management.bind(runtime);
  runtime.management = (environment, args, options = {}) => {
    if (args[0] === 'bash' && options.input?.includes("'MU_READY'")) {
      const marker = `sudo systemctl start ${GUEST_BROWSER_SERVICE}\n`;
      assert.equal(options.input.split(marker).length, 2, 'Candidate requires one guarded startup');
      const patch = `sudo python3 - <<'MU_GRAPHITE_CANDIDATE'
import pathlib,shlex
target=pathlib.Path('/usr/local/libexec/mu-guest-browser');lines=target.read_text().splitlines();count=0
for index,line in enumerate(lines):
 args=shlex.split(line)
 if args and args[0].endswith('/chrome-linux-arm64/chrome') and args[-1]=='&':
  assert '--use-angle=gl' in args and '--disable-accelerated-2d-canvas' in args
  assert not any(arg in args for arg in ['--no-sandbox','--disable-gpu-sandbox','--enable-unsafe-webgpu','--enable-unsafe-swiftshader'])
  lines[index]=shlex.join(args[:-1]+${JSON.stringify(GRAPHITE_CANDIDATE_FLAGS)})+' &';count+=1
assert count==1
target.write_text('\\n'.join(lines)+'\\n')
MU_GRAPHITE_CANDIDATE
`;
      options = { ...options, input: options.input.replace(marker, patch + marker) };
    }
    return original(environment, args, options);
  };
}
