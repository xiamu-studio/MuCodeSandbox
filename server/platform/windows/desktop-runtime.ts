// Fixed Ubuntu Noble names reviewed against the pinned clients' Debian control
// data. The t64 transitions retain the original ABI names declared by vendors.
export const WINDOWS_CLIENT_RUNTIME_PACKAGES=['libnotify4','libxss1','libxtst6','libuuid1','libsecret-1-0','libxcb-dri3-0','libglib2.0-bin','libc6','libpipewire-0.3-0t64','xdg-desktop-portal','xdg-desktop-portal-gtk'] as const;

const common=['libgtk-3-0t64','libnotify4','libnss3','xdg-utils','libatspi2.0-0t64','libdrm2','libgbm1','libsecret-1-0','libxtst6','libuuid1'];
export const WINDOWS_CLIENT_RUNTIME_REQUIREMENTS={
 'grok-bot':[...common,'libxss1','libasound2t64','libxkbcommon0'],
 'claude-desktop':[...common,'libxcb-dri3-0','libglib2.0-bin','libc6','libpipewire-0.3-0t64','xdg-desktop-portal','xdg-desktop-portal-gtk'],
} as const;

// Read-only package state, never ldd/client execution, package installation,
// D-Bus activation or a claim that the desktop session is usable.
export const WINDOWS_CLIENT_RUNTIME_PYTHON=String.raw`
import subprocess,json,re
MU_CLIENT_REQUIREMENTS=json.loads(${JSON.stringify(JSON.stringify(WINDOWS_CLIENT_RUNTIME_REQUIREMENTS))})
def mu_runtime_run(args):
 return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
def assert_desktop_runtime(application):
 if application not in MU_CLIENT_REQUIREMENTS:raise RuntimeError('Unknown desktop runtime')
 architecture=mu_runtime_run(['/usr/bin/dpkg','--print-architecture'])
 if architecture.returncode!=0 or architecture.stdout!=b'amd64\n':raise RuntimeError('Desktop runtime architecture mismatch')
 for name in MU_CLIENT_REQUIREMENTS[application]:
  query_format=chr(36)+'{db:Status-Status}'+r'\t'+chr(36)+'{Architecture}'+r'\t'+chr(36)+'{Version}'+r'\n'
  result=mu_runtime_run(['/usr/bin/dpkg-query','-W','-f='+query_format,name])
  if result.returncode!=0 or len(result.stdout)>1024 or len(result.stderr)>1024:raise RuntimeError('Desktop runtime package unavailable: '+name)
  try:parts=result.stdout.decode('ascii').removesuffix('\n').split('\t')
  except UnicodeError:raise RuntimeError('Desktop runtime package receipt invalid')
  if len(parts)!=3 or parts[0]!='installed' or parts[1] not in ['amd64','all'] or re.fullmatch(r'[0-9][A-Za-z0-9.+:~\-]*',parts[2]) is None:raise RuntimeError('Desktop runtime package receipt invalid')
  if name=='libc6' and mu_runtime_run(['/usr/bin/dpkg','--compare-versions',parts[2],'ge','2.34']).returncode!=0:raise RuntimeError('Desktop runtime libc version unsupported')
 return dict(version=1,application=application,state='packages-verified')
`;
