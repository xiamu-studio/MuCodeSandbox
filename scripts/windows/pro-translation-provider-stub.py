# Prefix to the exact production Python in the isolated acceptance process.
# Replaces curl before it can execute: no provider domain is contacted.
import os,sys,json,subprocess,types,pathlib,hashlib,time,pwd
_mu_dir=pathlib.Path('/tmp/mu-translation-'+MU_TRANSLATION_CASE)
def _mu_run(args,**kwargs):
 assert args[0]=='/usr/bin/curl' and '--config' in args and args[-1]=='-'
 assert '--location' not in args and '--insecure' not in args and '--retry' not in args
 assert '--ipv4' in args and '--max-time' in args and '--max-filesize' in args
 conf=dict(line.split(' = ',1) for line in kwargs['input'].splitlines() if not line.startswith('header'))
 assert json.loads(conf['url'])=='https://api.deepseek.com/chat/completions'
 data=json.loads(json.loads(conf['data']))
 assert data['model']=='deepseek-flash' and data['thinking']=={'type':'disabled'} and data['stream'] is False and 'tools' not in data
 assert len(data['messages'])==2 and 'never answer' in data['messages'][0]['content']
 assert os.getuid()==pwd.getpwnam('dev').pw_uid and os.geteuid()!=0
 source=data['messages'][1]['content'];mode=(_mu_dir/'mode').read_text()
 argv=pathlib.Path('/proc/self/cmdline').read_bytes()
 assert source.encode() not in argv and b'sk-synthetic-translation' not in argv
 proof={'pid':os.getpid(),'start':pathlib.Path('/proc/self/stat').read_text().split()[21],'uid':os.getuid(),'mode':mode,'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'sourceUnits':len(source.encode('utf-16-le'))//2,'target':'en' if data['messages'][0]['content'].endswith('English.') else 'zh','curlExecuted':False}
 (_mu_dir/'proof.json').write_text(json.dumps(proof));os.chmod(_mu_dir/'proof.json',0o600)
 if mode=='hold':time.sleep(45)
 if mode=='unauthorized':return types.SimpleNamespace(returncode=0,stdout='synthetic private body\n401')
 if mode=='oversize':reply='x'*64001
 else:reply='Local synthetic translation.\n\n1. Paragraph preserved.\n'
 return types.SimpleNamespace(returncode=0,stdout=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':reply}}]})+'\n200')
subprocess.run=_mu_run
