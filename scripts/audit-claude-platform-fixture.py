"""Read-only subprocess / MCP fixture for the isolated CLI audit, never a product plugin."""
import argparse, json, os, pathlib, sys

parser = argparse.ArgumentParser()
parser.add_argument('--events', required=True)
parser.add_argument('--probe', action='store_true')
parser.add_argument('--startup-read', action='store_true')
parser.add_argument('--hook', action='store_true')
args = parser.parse_args()
events = pathlib.Path(args.events)
if events.parent.parent.parent != pathlib.Path('/tmp') or not events.parent.parent.name.startswith('mu-client-audit-'):
    raise RuntimeError('Guest audit evidence directory required')
if os.geteuid() == 0:
    raise RuntimeError('Fixture must run as the unprivileged audit user')

def record(event, **details):
    with events.open('a') as output:
        output.write(json.dumps({'event': event, 'pid': os.getpid(), 'uid': os.geteuid(), **details})+'\n')

def platform(event):
    # A fixed, harmless system file; no arbitrary paths, account data, or network calls.
    text = pathlib.Path('/sys/class/dmi/id/product_name').read_text()[:256].strip()
    record(event, value=text)
    return text

record('process-start', mode='hook' if args.hook else 'probe' if args.probe else 'mcp')
if args.hook:
    request=json.loads(sys.stdin.read(65536))
    if request.get('hook_event_name')!='SessionStart':raise RuntimeError('Only SessionStart is supported')
    record('hook-input', hookEvent=request['hook_event_name'], inputKeys=sorted(request))
    print(json.dumps({'hookSpecificOutput': {'hookEventName':'SessionStart',
                      'additionalContext':'MU LOCAL AUDIT PLATFORM: '+platform('hook-read')}}))
    sys.exit(0)
if args.probe:
    print(platform('indirect-read'))
    sys.exit(0)
if args.startup_read:
    platform('mcp-startup-read')

for line in sys.stdin:
    if len(line) > 1024*1024:
        raise RuntimeError('MCP input budget exceeded')
    request = json.loads(line)
    method = request.get('method')
    record('rpc', method=method)
    if 'id' not in request:
        continue
    response = {'jsonrpc': '2.0', 'id': request['id']}
    if method == 'initialize':
        response['result'] = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                              'serverInfo': {'name': 'mu-local-audit', 'version': '1.0'}}
    elif method == 'ping':
        response['result'] = {}
    elif method == 'tools/list':
        response['result'] = {'tools': [{'name': 'read_platform',
            'description': 'Read one system platform label for this authorized local audit.',
            'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
            'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False}}]}
    elif method == 'tools/call' and request.get('params', {}).get('name') == 'read_platform':
        response['result'] = {'content': [{'type': 'text', 'text': platform('mcp-tool-read')}], 'isError': False}
    else:
        response['error'] = {'code': -32601, 'message': 'Only local audit methods are implemented'}
    print(json.dumps(response), flush=True)
