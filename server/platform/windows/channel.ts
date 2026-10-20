export const CHANNEL_PORT=40522;
export const CHANNEL_SERVICE='00009e4a-facb-11e6-bd58-64006a7986d3';

export const GUEST_CHANNEL=`#!/usr/bin/python3
import socket,threading
limit=threading.BoundedSemaphore(32)
def relay(a,b):
 try:
  while True:
   data=a.recv(65536)
   if not data: break
   b.sendall(data)
 except OSError: pass
 finally:
  for item in [a,b]:
   try: item.shutdown(socket.SHUT_RDWR)
   except OSError: pass
def connection(guest):
 try:
  local=socket.create_connection(('127.0.0.1',22),timeout=5)
  local.settimeout(None)
  worker=threading.Thread(target=relay,args=(guest,local),daemon=True);worker.start()
  relay(local,guest);worker.join(timeout=1)
  local.close()
 except OSError: pass
 finally: guest.close();limit.release()
server=socket.socket(socket.AF_VSOCK,socket.SOCK_STREAM)
server.bind((socket.VMADDR_CID_ANY,${CHANNEL_PORT}));server.listen(32)
while True:
 guest,peer=server.accept()
 if peer[0]!=socket.VMADDR_CID_HOST or not limit.acquire(blocking=False): guest.close();continue
 threading.Thread(target=connection,args=(guest,),daemon=True).start()
`;
export const GUEST_CHANNEL_UNIT=`[Unit]
Description=MuCodeSandbox host-initiated Hyper-V SSH channel
Requires=ssh.socket
After=ssh.socket
[Service]
ExecStartPre=/sbin/modprobe hv_sock
ExecStart=/usr/bin/python3 -u /usr/local/libexec/mu-hv-ssh
Restart=on-failure
RestartSec=1
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
`;
