"""Run the installed agent's real route preparation, stopping before DHCP I/O."""
import hashlib
import inspect
import json
import signal
import subprocess
import sys
from azurelinuxagent.common import conf, dhcp

def emit(event, **values):
    print(json.dumps(dict(event=event, **values)), flush=True)

def routes():
    return json.loads(subprocess.check_output(['ip', '-j', 'route', 'show', 'table', 'all'], text=True))

def timeout(*_):
    raise TimeoutError('Bounded agent route probe expired')

class RouteBoundary(Exception):
    pass

signal.signal(signal.SIGALRM, timeout)
signal.alarm(30)
conf.load_conf_from_file('/etc/waagent.conf')
handler = dhcp.get_dhcp_handler()
original = handler.osutil.set_route_for_dhcp_broadcast
emit('baseline', routes=routes(), module=dhcp.__file__,
     handlerSha256=hashlib.sha256(inspect.getsource(handler.send_dhcp_req).encode()).hexdigest(),
     mutatorSha256=hashlib.sha256(inspect.getsource(original).encode()).hexdigest())

def observed(interface):
    emit('before-route', interface=interface, routes=routes())
    result = original(interface)
    emit('after-route', interface=interface, routes=routes())
    # The real mutator already ran. Do not send a DHCP datagram merely to
    # reproduce a route-integrity failure in this isolated non-Azure VM.
    raise RouteBoundary()

handler.osutil.set_route_for_dhcp_broadcast = observed
try:
    handler.send_dhcp_req()
    emit('not-reproduced', reason='Agent did not prepare a broadcast route')
except RouteBoundary:
    emit('stopped-before-dhcp', dhcpSent=False)
except Exception as error:
    emit('probe-error', kind=type(error).__name__, message=str(error))
finally:
    signal.alarm(0)
