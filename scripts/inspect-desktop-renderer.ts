import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {LimaRuntime} from '../server/runtime.ts';
import {DESKTOP_ARGUMENTS_PYTHON} from '../server/guest-desktop.ts';
const db=new DatabaseSync('/Users/staff/.mucodesandbox/state.sqlite',{readOnly:true});
const row=db.prepare('SELECT config FROM environments WHERE id=?').get('76c193f7-09a2-4544-83b8-4852445ab2be') as {config:string};
db.close();const e=JSON.parse(row.config);
if(e.state!=='running')throw new Error('Environment must already be running');
const code=DESKTOP_ARGUMENTS_PYTHON+String.raw`
import pathlib,json,time,subprocess
uid=int(subprocess.check_output(['id','-u','dev']))
group=pathlib.Path('/sys/fs/cgroup/system.slice/mucodesandbox-desktop-claude-desktop.service/cgroup.procs')
end=time.monotonic()+40
last=None
while time.monotonic()<end:
    rows=[]
    for pid in group.read_text().split() if group.exists() else []:
        p=pathlib.Path('/proc')/pid
        try:
            args=desktop_arguments((p/'cmdline').read_bytes())
            role='renderer' if b'--type=renderer' in args else 'other'
            bad=[]
            if role=='renderer':
                for task in (p/'task').iterdir():
                    try:
                        s=dict(line.split(':',1) for line in (task/'status').read_text().splitlines() if ':' in line)
                        values={key:s.get(key,'').strip() for key in ['Seccomp','NoNewPrivs','CapEff','Uid','Name']}
                        if int(s.get('Seccomp','0'))!=2 or int(s.get('NoNewPrivs','0'))!=1 or int(s.get('CapEff','0'),16)!=0 or int(s['Uid'].split()[1])!=uid:
                            bad.append({'tid':task.name,**values})
                    except FileNotFoundError:pass
            rows.append({'pid':pid,'role':role,'noSandbox':b'--no-sandbox' in args,'badThreads':bad})
        except FileNotFoundError:pass
    state=json.dumps(rows,sort_keys=True)
    if state!=last:
        print(json.dumps({'at':time.time(),'processes':rows}),flush=True)
        last=state
    time.sleep(.1)
`;
const output=await new LimaRuntime('/Users/staff/.mucodesandbox').management(e,['python3','-c',code],{timeoutMs:45000,maxBytes:200000});
const dir='test-results/desktop-renderer';await mkdir(dir,{recursive:true});
const file=`${dir}/${new Date().toISOString().replaceAll(':','-')}.jsonl`;
await writeFile(file,output,{mode:0o600});console.log(file);console.log(output);
