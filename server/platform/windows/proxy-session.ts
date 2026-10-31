import {proxySessionScript} from '../../proxy-transport.ts';

// Optional evidence from the already-running protected journal. Parse inside
// the guest: only fixed category names cross the existing ownership channel.
// No new SSH connection, journal storage, network request or guard dependency.
const observer=String.raw`import json,re,subprocess,threading,time
mu_journal_stop=threading.Event()
mu_journal_gate=threading.Lock()
mu_journal_process=None

def mu_journal_emit(code):
 try:
  with mu_journal_gate:print('MU_GUEST_PROXY:'+code,flush=True)
 except (OSError,ValueError): pass

def mu_journal_ready():
 with mu_journal_gate:print('MU_PROXY_SESSION_READY',flush=True)

def mu_journal_watch():
 global mu_journal_process
 proc=None
 try:
  proc=subprocess.Popen(['/usr/bin/journalctl','--namespace=mucodesandbox-network','--unit=mucodesandbox-tunnel.service','--boot','--follow','--lines=0','--output=json','--no-pager'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  with mu_journal_gate:
   mu_journal_process=proc
   if mu_journal_stop.is_set():proc.terminate();return
  mu_journal_emit('FOLLOWING')
  last={};discarding=False
  while not mu_journal_stop.is_set():
   line=proc.stdout.readline(65537)
   if not line:break
   if len(line)>65536:discarding=not line.endswith(b'\n');continue
   if discarding:discarding=not line.endswith(b'\n');continue
   try:
    entry=json.loads(line)
    if not isinstance(entry,dict) or entry.get('_SYSTEMD_UNIT')!='mucodesandbox-tunnel.service':continue
    message=entry.get('MESSAGE')
    if not isinstance(message,str) or len(message)>8192:continue
    message=re.sub(r'\x1b\[[0-9;]*m','',message)
    if not re.search(r'\b(?:ERROR|WARN)\b',message):continue
    text=message.lower();codes=[]
    if 'connection reset by peer' in text:codes.append('RESET')
    if 'broken pipe' in text:codes.append('BROKEN_PIPE')
    if 'connection refused' in text:codes.append('REFUSED')
    if any(value in text for value in ['i/o timeout','context deadline exceeded','connection timed out']):codes.append('TIMEOUT')
    if any(value in text for value in ['tls:','x509:','tls handshake','certificate verify']):codes.append('TLS')
    if 'dns:' in text or 'lookup ' in text:codes.append('DNS')
    now=time.monotonic()
    for code in codes:
     if now-last.get(code,-2)>=1:last[code]=now;mu_journal_emit(code)
   except (ValueError,TypeError,UnicodeError):continue
  if not mu_journal_stop.is_set():mu_journal_emit('UNAVAILABLE')
 except Exception:
  if not mu_journal_stop.is_set():mu_journal_emit('UNAVAILABLE')
 finally:
  if proc is not None:
   try:
    if proc.poll() is None:proc.terminate()
    try:proc.wait(timeout=0.5)
    except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=0.5)
   except Exception:pass
   if proc.stdout is not None:proc.stdout.close()
  with mu_journal_gate:
   if mu_journal_process is proc:mu_journal_process=None

def mu_journal_close():
 mu_journal_stop.set()
 with mu_journal_gate:
  if mu_journal_process is not None:
   try:mu_journal_process.terminate()
   except OSError:pass

mu_journal_thread=threading.Thread(target=mu_journal_watch,daemon=True)
mu_journal_thread.start()
`;
// Even resource exhaustion while importing or starting the optional reader
// cannot prevent the existing ownership protocol from becoming ready.
export const WINDOWS_PROXY_OBSERVER="def mu_journal_close(): pass\ndef mu_journal_ready(): print('MU_PROXY_SESSION_READY',flush=True)\ntry:\n"+observer.trimEnd().split('\n').map(line=>' '+line).join('\n')+'\nexcept Exception:\n try: print(\'MU_GUEST_PROXY:UNAVAILABLE\',flush=True)\n except Exception: pass\n';
export const WINDOWS_PROXY_SESSION=proxySessionScript({start:WINDOWS_PROXY_OBSERVER,ready:'mu_journal_ready()\n',stop:' try: mu_journal_close()\n except Exception: pass\n'});
