// SSH cancellation alone can leave its remote process running. A guest-owned
// supervisor gives each bounded command a separate process group and cancel socket.
export const GUEST_TASK_RUN = String.raw`
import os, select, signal, socket, struct, subprocess, sys, time, uuid
token=str(uuid.UUID(sys.argv[1]))
budget=float(sys.argv[2])/1000
if budget <= 0 or budget > 86400: raise ValueError('Invalid task deadline')
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind('\0mucodesandbox-task-'+token)
server.listen(1)
requested=[]
def stop_signal(number, frame): requested.append(number)
for number in (signal.SIGHUP,signal.SIGINT,signal.SIGTERM): signal.signal(number,stop_signal)
child=subprocess.Popen(sys.argv[3:],start_new_session=True)
deadline=time.monotonic()+budget
code=None
try:
    while True:
        code=child.poll()
        if code is not None: break
        if requested or time.monotonic() >= deadline:
            if not requested: print('MU_GUEST_TASK_TIMEOUT',file=sys.stderr,flush=True)
            # Keep the child unreaped until the group is killed, preventing PID reuse.
            try: os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            time.sleep(0.3)
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
            code=128+requested[0] if requested else 124
            break
        readable,_,_=select.select([server],[],[],min(0.1,max(0,deadline-time.monotonic())))
        if readable:
            conn,_=server.accept()
            try:
                conn.settimeout(1)
                peer=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                if peer[1]==os.getuid() and conn.recv(16)==b'cancel':
                    requested.append(signal.SIGTERM)
                    conn.sendall(b'accepted')
            except (OSError,TimeoutError): pass
            finally: conn.close()
finally: server.close()
sys.exit(code if code is not None and code >= 0 else 128-(code or 0))
`;

export const GUEST_TASK_CANCEL = String.raw`
import socket, sys, time, uuid
address='\0mucodesandbox-task-'+str(uuid.UUID(sys.argv[1]))
deadline=time.monotonic()+2
while True:
    client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    client.settimeout(1)
    try:
        client.connect(address)
        client.sendall(b'cancel')
        if client.recv(16)!=b'accepted': raise RuntimeError('Task cancellation rejected')
        break
    except (ConnectionRefusedError,FileNotFoundError):
        if time.monotonic()>=deadline: break
        time.sleep(0.05)
    finally: client.close()
`;
