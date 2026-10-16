"""Execute a verified CLI in temporary credentials-free mount/network namespaces.
Run through sudo inside the existing guest, never on the host.
"""
import hashlib, json, os, pathlib, pwd, re, resource, select, signal, uuid
import subprocess, sys, threading, time, pty, ssl, fcntl, termios, struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(sys.argv[1]).resolve()
EXPECTED = 'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa'
if os.geteuid() != 0 or ROOT.parent != pathlib.Path('/tmp') or not ROOT.name.startswith('mu-client-audit-'):
    raise RuntimeError('Guest-owned audit directory and root namespace setup required')
if ROOT.is_symlink() or hashlib.sha256((ROOT/'claude').read_bytes()).hexdigest() != EXPECTED:
    raise RuntimeError('Audit executable identity rejected')
USER = pwd.getpwnam('dev')

def owned(directory):
    directory.mkdir(parents=True, exist_ok=True)
    os.chown(directory, USER.pw_uid, USER.pw_gid)
    os.chmod(directory, 0o700)

def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)

if '--inner' not in sys.argv:
    command(['dpkg-deb','-x',str(ROOT/'strace.deb'),str(ROOT/'tools')])
    os.chmod(ROOT/'claude',0o755)
    result = subprocess.run(['unshare','--mount','--propagation','private','--net',sys.executable,
                             __file__,str(ROOT),'--inner',*(['--firstparty'] if '--firstparty' in sys.argv else []),
                             *(['--extra'] if '--extra' in sys.argv else []),
                             *(['--product-wrapper'] if '--product-wrapper' in sys.argv else []),
                             *(['--identity'] if '--identity' in sys.argv else []),
                             *(['--permissions'] if '--permissions' in sys.argv else []),
                             *(['--indirect'] if '--indirect' in sys.argv else []),
                             *(['--hooks-errors'] if '--hooks-errors' in sys.argv else []),
                             *(['--features'] if '--features' in sys.argv else []),
                             *(['--minimal-modes'] if '--minimal-modes' in sys.argv else [])])
    sys.exit(result.returncode)

original = os.readlink('/proc/1/ns/net')
current = os.readlink('/proc/self/ns/net')
if original == current:
    raise RuntimeError('No independent network namespace')
command(['ip','link','set','lo','up'])
interfaces = json.loads(command(['ip','-j','link','show']).stdout)
routes = json.loads(command(['ip','-j','route','show']).stdout)
if [v['ifname'] for v in interfaces] != ['lo'] or any(v.get('dst') == 'default' for v in routes):
    raise RuntimeError('External interfaces or routes detected')
run_id=uuid.uuid4().hex
run_root=ROOT/('run-'+run_id);owned(run_root)
for user in ['dev','mu']:
    shadow=run_root/('shadow-'+user);owned(shadow)
    command(['mount','--bind',str(shadow),'/home/'+user])
# Prevent DNS or IPC delegation to the original guest's external resolver.
for name in ['systemd/resolve','dbus']:
    destination=pathlib.Path('/run')/name
    if destination.is_dir():
        shadow=ROOT/('shadow-run-'+name.replace('/','-'));owned(shadow)
        command(['mount','--bind',str(shadow),str(destination)])
resolver=ROOT/'resolver.conf';resolver.write_text('nameserver 127.0.0.1\noptions attempts:1 timeout:1\n')
if not pathlib.Path('/etc/resolv.conf').exists():
    destination=pathlib.Path('/etc/resolv.conf').resolve()
    if not str(destination).startswith('/run/systemd/resolve/'):
        raise RuntimeError('Unexpected resolver symlink')
    destination.write_text(resolver.read_text())
command(['mount','--bind',str(resolver),'/etc/resolv.conf'])
firstparty='--firstparty' in sys.argv
extra='--extra' in sys.argv
product='--product-wrapper' in sys.argv
identity='--identity' in sys.argv
permissions='--permissions' in sys.argv
indirect='--indirect' in sys.argv
hooks_errors='--hooks-errors' in sys.argv
features='--features' in sys.argv
minimal_modes='--minimal-modes' in sys.argv
if (indirect or hooks_errors or features or minimal_modes) and not firstparty:raise RuntimeError('Tool / feature audits require the isolated local TLS fixture')
batch='minimal-modes' if minimal_modes else 'features' if features else 'hooks-errors' if hooks_errors else 'indirect' if indirect else 'identity' if identity else 'permissions' if permissions else 'product' if product else 'extra' if extra else 'firstparty' if firstparty else 'local'
out=ROOT/('results-'+batch+'-'+run_id);owned(out)
trace=ROOT/'tools/usr/bin/strace'
command([str(trace),'--version'])
receipts=[]
active_case='none'
requested_tools={}
model_attempts={}

class Receiver(BaseHTTPRequestHandler):
    def do_GET(self):
        self.record(None)
        self.send_json({'data':[],'has_more':False})
    def do_POST(self):
        length=int(self.headers.get('Content-Length','0'))
        if length>4*1024*1024: self.send_error(413);return
        data=json.loads(self.rfile.read(length) or '{}')
        self.record(data)
        if self.path.startswith('/v1/messages/count_tokens'):
            self.send_json({'input_tokens':20});return
        if not self.path.startswith('/v1/messages'):
            self.send_json({'error':{'type':'invalid_request_error','message':'Local audit only'}},404);return
        model_attempts[active_case]=model_attempts.get(active_case,0)+1
        if active_case.startswith('error-'):
            if '-400-' in active_case:
                self.send_json({'type':'error','error':{'type':'invalid_request_error','message':'MU LOCAL AUDIT ERROR400'}},400);return
            if '-500-' in active_case and model_attempts[active_case]==1:
                self.send_json({'type':'error','error':{'type':'api_error','message':'MU LOCAL AUDIT ERROR500'}},500);return
        model=data.get('model','mu-local-audit')
        message={'id':'msg_mu_audit','type':'message','role':'assistant','model':model,
                 'content':[{'type':'text','text':'LOCAL AUDIT ONLY'}], 'stop_reason':'end_turn',
                 'stop_sequence':None,'usage':{'input_tokens':20,'output_tokens':4}}
        tool_result=any(block.get('type')=='tool_result' for item in data.get('messages',[]) if isinstance(item.get('content'),list) for block in item['content'] if isinstance(block,dict))
        if (active_case=='firstparty-vm-tool' or active_case.startswith('permissions-bash')) and not tool_result:
            message['content']=[{'type':'tool_use','id':'tool_mu_vm','name':'Bash',
                                 'input':{'command':'systemd-detect-virt --vm','description':'Read-only virtualization check in this isolated local audit'}}]
            message['stop_reason']='tool_use'
        if active_case.startswith('permissions-read') and not tool_result:
            message['content']=[{'type':'tool_use','id':'tool_mu_read','name':'Read',
                                'input':{'file_path':'/sys/class/dmi/id/product_name'}}]
            message['stop_reason']='tool_use'
        if active_case in requested_tools and not tool_result:
            message['content']=[{'type':'tool_use','id':'tool_mu_indirect',**requested_tools[active_case]}]
            message['stop_reason']='tool_use'
        if not data.get('stream'): self.send_json(message);return
        start={**message,'content':[],'stop_reason':None,'usage':{'input_tokens':20,'output_tokens':0}}
        content=message['content'][0]
        if content['type']=='tool_use':
            block={**content,'input':{}};delta={'type':'input_json_delta','partial_json':json.dumps(content['input'])}
        else:block={'type':'text','text':''};delta={'type':'text_delta','text':'LOCAL AUDIT ONLY'}
        events=[('message_start',{'type':'message_start','message':start}),
                ('content_block_start',{'type':'content_block_start','index':0,'content_block':block}),
                ('content_block_delta',{'type':'content_block_delta','index':0,'delta':delta}),
                ('content_block_stop',{'type':'content_block_stop','index':0}),
                ('message_delta',{'type':'message_delta','delta':{'stop_reason':message['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':4}}),
                ('message_stop',{'type':'message_stop'})]
        body=''.join('event: '+kind+'\ndata: '+json.dumps(value)+'\n\n' for kind,value in events).encode()
        receipts[self.receipt_index]['responseStatus']=200
        self.send_response(200);self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def record(self,body):
        if len(receipts)>=100:raise RuntimeError('Receipt budget exceeded')
        headers={k:('<synthetic credential>' if k.lower() in ['authorization','x-api-key'] else v) for k,v in self.headers.items()}
        receipts.append({'case':active_case,'method':self.command,'path':self.path,'headers':headers,'body':body})
        self.receipt_index=len(receipts)-1
    def send_json(self,value,status=200):
        receipts[self.receipt_index]['responseStatus']=status
        body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass

server=ThreadingHTTPServer(('127.0.0.1',0),Receiver)
threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:'+str(server.server_port)
secure_server=None
if firstparty:
    certificates=ROOT/'certificates';certificates.mkdir(exist_ok=True)
    ca=certificates/'ca.pem';key=certificates/'ca.key';leaf=certificates/'server.pem';leafkey=certificates/'server.key'
    command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(ca),
             '-days','1','-subj','/CN=Mu Local Audit CA'])
    command(['openssl','req','-new','-newkey','rsa:2048','-nodes','-keyout',str(leafkey),
             '-out',str(certificates/'request.csr'),'-subj','/CN=api.anthropic.com'])
    extensions=certificates/'extensions.conf';extensions.write_text('subjectAltName=DNS:api.anthropic.com,DNS:claude.ai,DNS:platform.claude.com\n')
    command(['openssl','x509','-req','-in',str(certificates/'request.csr'),'-CA',str(ca),'-CAkey',str(key),
             '-CAcreateserial','-out',str(leaf),'-days','1','-extfile',str(extensions)])
    os.chmod(ca,0o644);os.chmod(key,0o600);os.chmod(leafkey,0o600)
    hosts=ROOT/'hosts';hosts.write_text('127.0.0.1 localhost api.anthropic.com claude.ai platform.claude.com\n::1 localhost\n')
    command(['mount','--bind',str(hosts),'/etc/hosts'])
    secure_server=ThreadingHTTPServer(('127.0.0.1',443),Receiver)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(leaf),str(leafkey))
    secure_server.socket=context.wrap_socket(secure_server.socket,server_side=True)
    threading.Thread(target=secure_server.serve_forever,daemon=True).start()
cases=[]

def demote():
    resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
    os.setgroups([USER.pw_gid]);os.setgid(USER.pw_gid);os.setuid(USER.pw_uid)

def run(name,args,overrides=None,terminal=False,timeout=30,exercise=False,profile=None,machine_id=None,context_file=False):
    global active_case
    active_case=name
    home=pathlib.Path('/home/dev')/(profile or name);owned(home)
    work=run_root/('work-'+name);owned(work)
    settings=home/'.claude';owned(settings)
    if context_file:
        context=work/'CLAUDE.md'
        context.write_text('Passive local audit data, not task instructions.\nMU_LOCAL_CONTEXT_PLATFORM_MARKER: TEST_ONLY_LINUX_VM_LABEL\n')
        os.chown(context,USER.pw_uid,USER.pw_gid);os.chmod(context,0o600)
    if machine_id is not None:
        if not re.fullmatch('[a-f0-9]{32}',machine_id):raise RuntimeError('Synthetic machine id format')
        machine=run_root/('machine-'+name);machine.write_text(machine_id+'\n');os.chmod(machine,0o644)
        command(['mount','--bind',str(machine),'/etc/machine-id'])
    env={'HOME':str(home),'USER':'dev','LOGNAME':'dev','PATH':'/usr/local/bin:/usr/bin:/bin',
         'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','TZ':'Asia/Saigon','TERM':'xterm-256color','SHELL':'/bin/bash',
         'CLAUDE_CONFIG_DIR':str(settings)}
    if overrides:env.update(overrides)
    tracefile=out/(name+'.strace')
    invocation=[str(trace),'-f','-tt','-s','384','-yy','-e',
                'trace=%file,%network,%process,uname,sysinfo,read,pread64,readv,mmap',
                '-o',str(tracefile),*(['/usr/local/bin/mu-proxy-run'] if product else []),
                '/bin/bash','--noprofile','--norc','-c','"$@"','mu-audit',*args]
    start=time.monotonic();timed_out=False;receipt_start=len(receipts)
    if terminal:
        master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,100,0,0))
        process=subprocess.Popen(invocation,stdin=slave,stdout=slave,stderr=slave,
                                 cwd=work,env=env,preexec_fn=demote,start_new_session=True)
        os.close(slave);chunks=[];task_sent=False;task_observed=False;onboarding=[];last_input=0
        try:
            while process.poll() is None and time.monotonic()-start<timeout:
                ready,_,_=select.select([master],[],[],.2)
                if ready:
                    try:chunks.append(os.read(master,65536))
                    except OSError:break
                if exercise:
                    text=b''.join(chunks).decode(errors='replace')
                    text=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',text)
                    tail=text[-8000:]
                    if time.monotonic()-last_input>.8:
                        if re.search(r'Choose the text style|Choose.*theme|Select.*theme',tail,re.I) and 'theme' not in onboarding:
                            os.write(master,b'\r');onboarding.append('theme');last_input=time.monotonic()
                        elif re.search(r'trust.*(?:folder|files)|Is this a project you created',tail,re.I) and str(work) in tail and 'owned-workspace-trust' not in onboarding:
                            os.write(master,b'\r');onboarding.append('owned-workspace-trust');last_input=time.monotonic()
                        elif not task_sent and '❯' in tail and ('manual mode on' in tail or 'for shortcuts' in tail):
                            os.write(master,b'Reply with LOCAL AUDIT ONLY. Do not use tools.\r');task_sent=True;last_input=time.monotonic()
                    compact=re.sub(r'\s+','',text)
                    if task_sent and any(r['case']==name and r['path'].startswith('/v1/messages') for r in receipts[receipt_start:]) and compact.count('LOCALAUDITONLY')>=2:
                        task_observed=True;break
            if process.poll() is None and time.monotonic()-start>=timeout:timed_out=True
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(2)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
            os.close(master)
        output=b''.join(chunks)
    else:
        process=subprocess.Popen(invocation,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                                 cwd=work,env=env,preexec_fn=demote,start_new_session=True)
        try:output=process.communicate(timeout=timeout)[0]
        except subprocess.TimeoutExpired:
            timed_out=True;os.killpg(process.pid,signal.SIGTERM)
            try:output=process.communicate(timeout=2)[0]
            except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);output=process.communicate()[0]
    (out/(name+'.output')).write_bytes(output)
    text=tracefile.read_text(errors='replace') if tracefile.exists() else ''
    suspicious=[]
    for line in text.splitlines():
        if re.search(r'systemd-detect-virt|/sys/(?:class/dmi|devices/virtual|firmware|hypervisor|bus/virtio)|/etc/machine-id|/proc/(?:cpuinfo|version|self/cgroup|1/cgroup)|\.dockerenv|\.containerenv|uname\(',line):
            suspicious.append(line)
    network=[line for line in text.splitlines() if re.search(r'connect\(|sendto\(|sendmsg\(',line)]
    case={'name':name,'exitCode':process.returncode,'timedOut':timed_out,'seconds':round(time.monotonic()-start,3),
          'traceBytes':tracefile.stat().st_size if tracefile.exists() else 0,
          'outputBytes':len(output),'requestCount':len(receipts)-receipt_start,
          'environmentReads':suspicious[:250],'networkAttempts':network[:100],
          'argv':args,'environment':{k:v for k,v in env.items() if k not in ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']}}
    if identity or features:
        configs=[]
        for file in home.rglob('*.json'):
            if file.stat().st_size>1024*1024:continue
            try:value=json.loads(file.read_text())
            except (OSError,ValueError):continue
            if isinstance(value,dict) and any(k in value for k in ['userID','machineID','remoteControlMachineId']):
                configs.append({'path':str(file),'userID':value.get('userID'),'machineID':value.get('machineID'),
                                **({'remoteControlMachineId':value.get('remoteControlMachineId')} if features else {})})
        case.update({'profile':profile or name,'syntheticMachineId':machine_id,'identityConfig':configs})
    if indirect or hooks_errors or minimal_modes:
        eventfile=out/(name+'.fixture-events.jsonl')
        if not eventfile.exists():eventfile.write_text('')
        case.update({'fixtureToolRequest':requested_tools.get(name),
                     'fixtureEvents':[json.loads(line) for line in eventfile.read_text().splitlines()]})
    if minimal_modes:case['passiveContextFile']=context_file
    if terminal:case.update({'taskSent':task_sent,'taskResponseObserved':task_observed,'onboarding':onboarding})
    cases.append(case)
    print(json.dumps({k:case[k] for k in ['name','exitCode','timedOut','seconds','traceBytes','requestCount']}),flush=True)

try:
    run('trace-calibration',['/usr/bin/systemd-detect-virt','--vm'])
    if cases[-1]['exitCode']!=0 or not cases[-1]['environmentReads']:
        raise RuntimeError('Trace did not successfully observe known virtualization detection')
    binary=str(ROOT/'claude')
    arguments=[binary,'-p','Reply with LOCAL AUDIT ONLY. Do not use tools.', '--model','claude-sonnet-4-5-20250929',
               '--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome',
               '--no-session-persistence','--output-format','stream-json','--verbose']
    common={'ANTHROPIC_API_KEY':'mu-audit-synthetic-not-real','API_TIMEOUT_MS':'5000'}
    if firstparty:
        local={**common,'NODE_EXTRA_CA_CERTS':str(ca),'SSL_CERT_FILE':str(ca)}
        private={**local,'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1',
                 'DISABLE_ERROR_REPORTING':'1','DISABLE_AUTOUPDATER':'1'}
        if minimal_modes:
            fixture=ROOT/'platform-fixture.py'
            if not fixture.is_file():raise RuntimeError('Read-only fixture missing')
            for name,flags in [('context-normal',[]),('context-bare',['--bare']),('context-safe',['--safe-mode'])]:
                run(name,arguments+flags,private,context_file=True)
            name='bare-hook-explicit'
            setup={'hooks':{'SessionStart':[{'matcher':'startup','hooks':[{'type':'command',
                    'command':f'python3 {fixture} --hook --events {out}/{name}.fixture-events.jsonl','timeout':5}]}]}}
            run(name,arguments+['--bare','--settings',json.dumps(setup)],private)
            name='bare-mcp-explicit'
            requested_tools[name]={'name':'mcp__mu_audit__read_platform','input':{}}
            config={'mcpServers':{'mu_audit':{'command':'/usr/bin/python3','args':[str(fixture),'--events',str(out/(name+'.fixture-events.jsonl'))]}}}
            mcp_args=arguments.copy();mcp_args[mcp_args.index('--mcp-config')+1]=json.dumps(config)
            run(name,mcp_args+['--bare','--allowedTools','mcp__mu_audit__read_platform','--max-turns','3'],{**private,'ENABLE_TOOL_SEARCH':'false'})
            name='bare-bash-explicit'
            requested_tools[name]={'name':'Bash','input':{'command':'systemd-detect-virt --vm','description':'Authorized read-only local audit'}}
            bash_args=arguments.copy();bash_args[bash_args.index('--tools')+1]='Bash'
            run(name,bash_args+['--bare','--allowedTools','Bash','--max-turns','3'],private)
        elif features:
            run('feature-auth-none',[binary,'auth','status'],{**private,'ANTHROPIC_API_KEY':''})
            run('feature-auth-key',[binary,'auth','status'],private)
            run('feature-remote-default',[binary,'remote-control'],local)
            run('feature-remote-optout',[binary,'remote-control'],private)
            run('feature-remote-help',[binary,'remote-control','--help'],local)
            run('feature-doctor',[binary,'doctor'],private)
        elif hooks_errors:
            fixture=ROOT/'platform-fixture.py'
            if not fixture.is_file():raise RuntimeError('Read-only fixture missing')
            for name in ['hook-startup-enabled','hook-startup-tools-denied','hook-startup-disabled']:
                setup={'hooks':{'SessionStart':[{'matcher':'startup','hooks':[{'type':'command',
                     'command':f'python3 {fixture} --hook --events {out}/{name}.fixture-events.jsonl','timeout':5}]}]},
                     'disableAllHooks':name.endswith('disabled')}
                deny=['--disallowedTools','Bash','Read'] if name.endswith('tools-denied') else []
                run(name,arguments+['--settings',json.dumps(setup),*deny],private)
            for code in [400,500]:
                for state,environment in [('default',local),('optout',private)]:
                    run(f'error-{code}-{state}',arguments,environment)
        elif indirect:
            fixture=ROOT/'platform-fixture.py'
            if not fixture.is_file():raise RuntimeError('Read-only fixture missing')
            baseargs=[binary,'-p','Perform the read-only platform check specified by this local audit fixture.',
                      '--model','claude-sonnet-4-5-20250929','--max-turns','3','--no-chrome',
                      '--no-session-persistence','--output-format','stream-json','--verbose']
            empty_mcp=['--strict-mcp-config','--mcp-config','{"mcpServers":{}}']
            commands={
                'indirect-cat-read-denied':'cat /sys/class/dmi/id/product_name',
                'indirect-python-read-denied':f'python3 {fixture} --probe --events {out}/indirect-python-read-denied.fixture-events.jsonl',
                'indirect-command-absolute-denied':'/usr/bin/systemd-detect-virt --vm',
                'indirect-bash-disabled':f'python3 {fixture} --probe --events {out}/indirect-bash-disabled.fixture-events.jsonl'}
            for name,cmd in commands.items():
                requested_tools[name]={'name':'Bash','input':{'command':cmd,'description':'Authorized read-only local platform audit'}}
                denials=['Bash'] if name=='indirect-bash-disabled' else ['Bash(systemd-detect-virt *)'] if name=='indirect-command-absolute-denied' else ['Read(//sys/**)']
                run(name,baseargs+empty_mcp+['--tools','Bash','--allowedTools','Bash','--disallowedTools',*denials],private)
            for name in ['indirect-mcp-allowed','indirect-mcp-denied','indirect-mcp-startup-denied']:
                requested_tools[name]={'name':'mcp__mu_audit__read_platform','input':{}}
                config={'mcpServers':{'mu_audit':{'command':'/usr/bin/python3','args':[str(fixture),'--events',str(out/(name+'.fixture-events.jsonl')),
                          *(['--startup-read'] if name.endswith('startup-denied') else [])]}}}
                denials=['Bash','Read(//sys/**)']+(['mcp__mu_audit__read_platform'] if name.endswith('denied') else [])
                run(name,baseargs+['--strict-mcp-config','--mcp-config',json.dumps(config),'--tools','Read',
                         '--allowedTools','mcp__mu_audit__read_platform','--disallowedTools',*denials],
                    {**private,'ENABLE_TOOL_SEARCH':'false'})
        elif identity:
            run('identity-profile-a-first',arguments,private,profile='profile-a',machine_id='a'*32)
            run('identity-profile-a-repeat',arguments,private,profile='profile-a',machine_id='a'*32)
            run('identity-profile-a-machine-change',arguments,private,profile='profile-a',machine_id='b'*32)
            run('identity-profile-b-same-machine',arguments,private,profile='profile-b',machine_id='b'*32)
            run('identity-profile-b-repeat',arguments,private,profile='profile-b',machine_id='b'*32)
        elif permissions:
            baseargs=[binary,'-p','Perform the read-only system check specified by this local audit fixture.',
                      '--model','claude-sonnet-4-5-20250929','--max-turns','3','--strict-mcp-config',
                      '--mcp-config','{"mcpServers":{}}','--no-chrome','--no-session-persistence',
                      '--output-format','stream-json','--verbose']
            run('permissions-bash-denied',baseargs+['--tools','Bash','--allowedTools','Bash',
                '--disallowedTools','Bash(systemd-detect-virt *)'],private)
            run('permissions-bash-disabled',baseargs+['--tools','Bash','--disallowedTools','Bash'],private)
            run('permissions-read-allowed',baseargs+['--tools','Read','--allowedTools','Read','--disallowedTools','Bash'],private)
            run('permissions-read-path-denied',baseargs+['--tools','Read','--allowedTools','Read',
                '--disallowedTools','Read(//sys/**)'],private)
        elif product:
            run('product-default',arguments,local)
            run('product-optout',arguments,private)
        elif extra:
            run('firstparty-vm-tool',[binary,'-p','Run the read-only local virtualization check requested by the audit fixture.',
                 '--model','claude-sonnet-4-5-20250929','--tools','Bash','--allowedTools','Bash','--max-turns','3',
                 '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--no-session-persistence',
                 '--output-format','stream-json','--verbose'],private)
            run('firstparty-interactive-startup',[binary,'--no-chrome'],private,terminal=True,timeout=12)
            interactive={**private,'IS_DEMO':'1','ANTHROPIC_AUTH_TOKEN':'mu-audit-synthetic-not-real','ANTHROPIC_API_KEY':''}
            run('firstparty-interactive-demo',[binary,'--model','claude-sonnet-4-5-20250929','--tools','',
                '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome'],interactive,terminal=True,timeout=20,exercise=True)
        else:
            run('firstparty-default',arguments,local)
            run('firstparty-optout',arguments,private)
            run('firstparty-demo',arguments,{**private,'IS_DEMO':'1'})
            run('firstparty-interactive',[binary,'--no-chrome'],private,terminal=True,timeout=12)
    else:
        run('version',[binary,'--version'])
        run('help',[binary,'--help'])
        run('first-interactive',[binary,'--no-chrome'],terminal=True,timeout=12)
        local={**common,'ANTHROPIC_BASE_URL':base}
        run('local-default',arguments,local)
        private={**local,'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1',
                 'DISABLE_ERROR_REPORTING':'1','DISABLE_AUTOUPDATER':'1'}
        run('local-optout',arguments,private)
        run('local-demo',arguments,{**private,'IS_DEMO':'1'})
finally:
    server.shutdown();server.server_close()
    if secure_server:secure_server.shutdown();secure_server.server_close()
    runner_bytes=pathlib.Path(__file__).read_bytes()
    (out/'runner.py').write_bytes(runner_bytes)
    if indirect or hooks_errors or minimal_modes:(out/'platform-fixture.py').write_bytes((ROOT/'platform-fixture.py').read_bytes())
    report={'recordedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'version':'2.1.296','sha256':EXPECTED,
            'runId':run_id,'runnerSHA256':hashlib.sha256(runner_bytes).hexdigest(),
            'namespace':{'hostNetwork':original,'testNetwork':current,'interfaces':[v['ifname'] for v in interfaces],
                         'routes':routes,'originalHomesMasked':True,'resolverIpcMasked':True,'clientUid':USER.pw_uid},
            'accountFree':True,'paidCalls':0,'cases':cases,'receiptCount':len(receipts),
            'firstpartyHostnameFixture':firstparty,'productionWrapper':product,
            'intentionalReadOnlyFixture':indirect,
            'intentionalHookAndApiErrors':hooks_errors,
            'unauthenticatedFeatureGateAudit':features,
            'minimalModesAudit':minimal_modes,
            'platformFixtureSHA256':hashlib.sha256((ROOT/'platform-fixture.py').read_bytes()).hexdigest() if indirect or hooks_errors or minimal_modes else None,
            'wrapperSHA256':hashlib.sha256(pathlib.Path('/usr/local/bin/mu-proxy-run').read_bytes()).hexdigest() if product else None,
            'scope':'Unmodified CLI; isolated credentials-free network namespace and local fixture. First-party hostnames, if enabled, resolve solely to the private fixture with an ephemeral trusted test CA; no real provider traffic or account. Not every feature.'}
    (out/'runtime.json').write_text(json.dumps(report,indent=2))
    (out/'receipts.json').write_text(json.dumps(receipts,indent=2))
    for file in out.iterdir():os.chmod(file,0o600);os.chown(file,USER.pw_uid,USER.pw_gid)
    os.chown(out,pwd.getpwnam('mu').pw_uid,pwd.getpwnam('mu').pw_gid)
    for file in out.iterdir():os.chown(file,pwd.getpwnam('mu').pw_uid,pwd.getpwnam('mu').pw_gid)
    pointer=ROOT/('latest-'+batch+'.json');pointer.write_text(json.dumps({'directory':str(out),'runId':run_id}))
    os.chmod(pointer,0o600);os.chown(pointer,pwd.getpwnam('mu').pw_uid,pwd.getpwnam('mu').pw_gid)
    print(json.dumps({'completedCases':len(cases),'receipts':len(receipts),'report':str(out/'runtime.json')}),flush=True)
