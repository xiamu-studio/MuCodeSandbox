import {WINDOWS_AGENT_VERSION} from '../../../shared/windows-agent.ts';

// Approved npm Linux/glibc distribution. Registry signatures and SHA-512 were
// verified before pinning; installation never resolves a mutable latest tag.
export const WINDOWS_AGENT={
 name:'@anthropic-ai/claude-code-linux-x64',version:WINDOWS_AGENT_VERSION,
 url:'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.310.tgz',
 bytes:131844169,sha256:'8c90b0170d08fdb370db282c61d74897b834fc2569dd14c35eb1e491212dc6de',
 integrity:'sha512-CuzpJrMBbqaR3+1SiLrBtPV3w/cFvcqBfhe9kNskzZ2Fm6KXa7v0l7tM+Ln6l5QLb79WoU0CcacXnYtsygbe6A==',
 files:{
  claude:{bytes:291638640,sha256:'b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56'},
  'package.json':{bytes:289,sha256:'a8e8a6d6663db797da5349e82341b3070d84289cc28fc58d73c9cbc40983c016'},
  'LICENSE.md':{bytes:147,sha256:'8ce94b9478bb9868f9641f818e06cd722fbe55d4c22e2d2ed11971b20146173a'},
  'README.md':{bytes:150,sha256:'ab4b9d72c3aa1ac7357e8eeb8b77c62e308e9af01ac0ecdb181f3bf1e57e25d5'},
 },
} as const;
export const WINDOWS_AGENT_ROOT='/opt/mucodesandbox/windows/claude-code-'+WINDOWS_AGENT_VERSION;
export const WINDOWS_AGENT_EXECUTABLE=WINDOWS_AGENT_ROOT+'/claude';
export const WINDOWS_AGENT_PRIVACY=['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1','DISABLE_AUTOUPDATER=1','DISABLE_TELEMETRY=1','DISABLE_ERROR_REPORTING=1'] as const;
