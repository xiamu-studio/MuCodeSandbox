import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {INSPECT_WINDOWS_GUARD} from '../server/platform/windows/guest.ts';

test('Firewall digest excludes only the designated expiring permit elements',()=>{
 const start=INSPECT_WINDOWS_GUARD.indexOf('tables=[]');
 const end=INSPECT_WINDOWS_GUARD.indexOf('\nfiles={}',start);assert.ok(start>=0&&end>start);
 const python=`
import json,copy
source=${JSON.stringify(INSPECT_WINDOWS_GUARD.slice(start,end))}
base={'mu_egress':{'nftables':[{'set':{'family':'inet','table':'mu_egress','name':'other','elem':['192.0.2.1']}}]},'mu_lease':{'nftables':[{'set':{'family':'inet','table':'mu_lease','name':'permit','type':'nf_proto','timeout':45000,'elem':[]}}]}}
def digest(value):
 def cmd(*args): return json.dumps(value[args[-1]])
 context={'cmd':cmd,'json':json}
 exec(source,context)
 return json.dumps(context['tables'],sort_keys=True)
original=digest(base)
renewed=copy.deepcopy(base)
renewed['mu_lease']['nftables'][0]['set']['elem']=[{'elem':{'val':'ipv4','expires':44000}}]
assert digest(renewed)==original
for table in ['mu_egress','mu_lease']:
 value=copy.deepcopy(base)
 value[table]['nftables'].append({'set':{'family':'inet','table':table,'name':'static','elem':['192.0.2.1']}})
 before=digest(value)
 value[table]['nftables'][-1]['set']['elem']=['192.0.2.2']
 assert digest(value)!=before
value=copy.deepcopy(base)
value['mu_lease']['nftables'][0]['set']['timeout']=90000
assert digest(value)!=original
for field,new in [('family','ip'),('table','other'),('name','other')]:
 value=copy.deepcopy(base)
 value['mu_lease']['nftables'][0]['set'][field]=new
 before=digest(value)
 value['mu_lease']['nftables'][0]['set']['elem']=['ipv4']
 assert digest(value)!=before
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('Controlled DNS checks reject additional servers, misleading prefixes and duplicated global rows',()=>{
 const start=INSPECT_WINDOWS_GUARD.indexOf('def check_controlled_dns(dns,domains):');
 const end=INSPECT_WINDOWS_GUARD.indexOf('\ncheck_controlled_dns(dns,domains)',start);
 assert.ok(start>=0&&end>start);
 const python=`
${INSPECT_WINDOWS_GUARD.slice(start,end)}
good_dns='Global: 172.19.0.2\\nLink 2 (eth0):\\n'
good_domains='Global: ~.\\nLink 2 (eth0):\\n'
check_controlled_dns(good_dns,good_domains)
check_controlled_dns(' Global:   172.19.0.2  \\n',good_domains)
for dns,domains in [
 ('Global: 172.19.0.2 203.0.113.53',good_domains),
 ('Global: 172.19.0.20',good_domains),
 ('Link 2 (Global: 172.19.0.2):',good_domains),
 ('Global: 172.19.0.2\\nGlobal: 172.19.0.2',good_domains),
 ('',good_domains),
 (good_dns,'Global: ~. ~example.test'),
 (good_dns,'Global: ~.example.test'),
 (good_dns,'Global: ~.\\nGlobal: ~.'),
 (good_dns,'')]:
 try: check_controlled_dns(dns,domains)
 except RuntimeError: pass
 else: raise AssertionError('unexpected global DNS configuration accepted')
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('Cloud agent checks batch status reads and reject missing, duplicated or unsafe units',()=>{
 assert.match(INSPECT_WINDOWS_GUARD,/^sudo \/usr\/bin\/python3 -I - /);
 const start=INSPECT_WINDOWS_GUARD.indexOf('def check_masked_services(units):');
 const end=INSPECT_WINDOWS_GUARD.indexOf('\ncloud_agents=',start);
 assert.ok(start>=0&&end>start);
 const production=INSPECT_WINDOWS_GUARD.slice(start,end);
 const python=`
calls=[]
response=''
def cmd(*args):
 calls.append(args)
 if response is None: raise OSError('command failed')
 return response
${production}
def check(value,valid):
 global response
 response=value
 calls.clear()
 try: check_masked_services(['one.service','two.service'])
 except Exception:
  if valid: raise
 else:
  if not valid: raise AssertionError('unsafe status accepted')
 assert calls == [('systemctl','show','--property=Id','--property=UnitFileState','--property=ActiveState','--property=MainPID','one.service','two.service')]
def block(unit,state='inactive',mode='masked',pid='0'):
 return 'Id='+unit+'\\nMainPID='+pid+'\\nActiveState='+state+'\\nUnitFileState='+mode+'\\n'
one=block('one.service')
two=block('two.service','failed')
check(one+'\\n'+two,True)
check(two+'\\n'+one,True)
for value in [None,'',one,one+'\\n'+one,one+'\\n'+block('other.service'),one+'\\n'+block('two.service',mode='enabled'),one+'\\n'+block('two.service',state='active'),one+'\\n'+block('two.service',pid='9'),one+'\\n'+two+'UnitFileState=masked\\n',one+'\\n'+two+'Unexpected=x\\n']:
 check(value,False)
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('Network service checks require an active and enabled result for every requested service',()=>{
 const start=INSPECT_WINDOWS_GUARD.indexOf('def check_network_services(services):');
 const end=INSPECT_WINDOWS_GUARD.indexOf('\ncheck_network_services(',start);
 assert.ok(start>=0&&end>start);
 const production=INSPECT_WINDOWS_GUARD.slice(start,end);
 const python=`
responses={}
calls=[]
def cmd(*args):
 calls.append(args)
 value=responses[args[1]]
 if value is None: raise OSError('command failed')
 return value
${production}
services=['one','two','three']
def check(active,enabled,valid):
 global responses
 calls.clear();responses={'is-active':active,'is-enabled':enabled}
 try: check_network_services(services)
 except Exception:
  if valid: raise
 else:
  if not valid: raise AssertionError('unsafe or incomplete status accepted')
 if valid: assert calls == [('systemctl','is-active',*services),('systemctl','is-enabled',*services)]
check('active\\nactive\\nactive\\n','enabled\\nenabled\\nenabled\\n',True)
check('active\\nactive\\nactive\\n','enabled\\nenabled-runtime\\nenabled\\n',True)
for active,enabled in [(None,'enabled\\n'*3),('active\\n'*3,None),('active\\n'*2,'enabled\\n'*3),('active\\ninactive\\nactive\\n','enabled\\n'*3),('active\\n'*3,'enabled\\ndisabled\\nenabled\\n'),('active\\n'*3,'enabled\\n'*2),('active\\n'*4,'enabled\\n'*3)]: check(active,enabled,False)
`;
 const result=spawnSync('python',['-c',python],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
