import http.server
import json
import socket
import threading
from pathlib import Path

config = json.loads(Path('/etc/mucodesandbox/port-fixture.json').read_text())


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'MU_PORT_FIXTURE')

    def log_message(self, *args):
        pass


def tcp(address, port):
    http.server.ThreadingHTTPServer((address, port), Handler).serve_forever()


def udp(address, port):
    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listener.bind((address, port))
    while True:
        data, peer = listener.recvfrom(1024)
        if data == b'MU_PORT_PROBE':
            listener.sendto(b'MU_PORT_FIXTURE', peer)


for name, address, handler in [('tcpWildcard', '0.0.0.0', tcp), ('tcpLoopback', '127.0.0.1', tcp), ('udpWildcard', '0.0.0.0', udp), ('udpLoopback', '127.0.0.1', udp), ('explicit', '0.0.0.0', tcp)]:
    threading.Thread(target=handler, args=(address, config[name]), daemon=True).start()
threading.Event().wait()
