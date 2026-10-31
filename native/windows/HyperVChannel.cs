using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Collections.Generic;

// Host-initiated SSH transport to one exact VM and one fixed guest service.
// Only an owner-scoped IPv4 loopback listener; no shell, registry writes,
// external IP listener, network fallback or VM wildcards.
public sealed class MuHyperVEndpoint : EndPoint {
    private readonly Guid vm;
    private static readonly Guid service = new Guid("00009e4a-facb-11e6-bd58-64006a7986d3");
    public MuHyperVEndpoint(Guid value) { vm = value; }
    public override AddressFamily AddressFamily { get { return (AddressFamily)34; } }
    public override SocketAddress Serialize() {
        var address = new SocketAddress(AddressFamily, 36);
        var vmBytes = vm.ToByteArray(); var serviceBytes = service.ToByteArray();
        for (int i = 0; i < 16; i++) { address[i + 4] = vmBytes[i]; address[i + 20] = serviceBytes[i]; }
        return address;
    }
}
// Each fixed category retains a chance to report later failures even when
// startup repeatedly times out. The broker independently caps persisted data.
public sealed class MuChannelDiagnosticLimiter {
    private readonly long[] next=new long[5];
    public bool Allow(string code,long now) {
        int i=code=="capacity"?0:code=="guest-connect-socket"?1:code=="guest-connect-timeout"?2:code=="guest-send-error"?3:code=="guest-recv-error"?4:-1;
        if(i<0||now<0)return false;
        lock(next){if(next[i]!=0&&now<next[i])return false;next[i]=now>long.MaxValue-60000?long.MaxValue:now+60000;return true;}
    }
}
public static class MuHyperVChannel {
    private static readonly MuChannelDiagnosticLimiter diagnostics=new MuChannelDiagnosticLimiter();
    // Both pumps block for the lifetime of a connection. Pool starvation must
    // not delay new SSH admissions; the listener's semaphore bounds threads.
    private static void StartConnection(ThreadStart work){var worker=new Thread(work);worker.IsBackground=true;worker.Start();}
    // Fixed event names only: never write connection contents, addresses or exception text.
    private static void Diagnostic(string code){try{if(diagnostics.Allow(code,MuPowerWatch.Tick))Console.Error.WriteLine("MU_CHANNEL:"+code);}catch{/* Diagnostics never affect transport. */}}
    [DllImport("Ws2_32.dll")] private static extern int WSAStartup(ushort version, IntPtr data);
    [DllImport("Ws2_32.dll")] private static extern int WSACleanup();
    [DllImport("Ws2_32.dll")] private static extern IntPtr socket(int family, int type, int protocol);
    [DllImport("Ws2_32.dll")] private static extern int connect(IntPtr socket, byte[] address, int length);
    [DllImport("Ws2_32.dll")] private static extern int send(IntPtr socket, IntPtr data, int count, int flags);
    [DllImport("Ws2_32.dll")] private static extern int recv(IntPtr socket, [Out] byte[] data, int count, int flags);
    [DllImport("Ws2_32.dll")] private static extern int shutdown(IntPtr socket, int how);
    [DllImport("Ws2_32.dll")] private static extern int closesocket(IntPtr socket);
    [DllImport("Ws2_32.dll")] private static extern int WSAGetLastError();
    [DllImport("Ws2_32.dll")] private static extern int ioctlsocket(IntPtr socket, int command, ref uint value);
    [DllImport("Ws2_32.dll")] private static extern int select(int ignored, IntPtr read, IntPtr write, IntPtr error, ref TimeValue timeout);
    [DllImport("Ws2_32.dll")] private static extern int getsockopt(IntPtr socket, int level, int option, out int value, ref int length);
    [StructLayout(LayoutKind.Sequential)] private struct TimeValue { public int seconds; public int microseconds; }
    private const int FIONBIO=unchecked((int)0x8004667e), WSAEWOULDBLOCK=10035, SOL_SOCKET=0xffff, SO_ERROR=0x1007;
    private static IntPtr OneSocketSet(IntPtr value){
        var memory=Marshal.AllocHGlobal(IntPtr.Size+IntPtr.Size);
        try{Marshal.WriteInt32(memory,1);Marshal.WriteIntPtr(memory,IntPtr.Size,value);return memory;}
        catch{Marshal.FreeHGlobal(memory);throw;}
    }
    // The calling thread owns every native operation and wait. No worker may
    // still be in connect/recv when that owner closes or transfers its socket.
    private static void WaitGuestSocket(IntPtr raw,bool reading,int timeoutMs){
        if(timeoutMs<1||timeoutMs>5000)throw new ArgumentOutOfRangeException("timeoutMs");
        IntPtr readySet=IntPtr.Zero,errorSet=IntPtr.Zero;
        try{
            readySet=OneSocketSet(raw);if(!reading)errorSet=OneSocketSet(raw);
            var timeout=new TimeValue{seconds=timeoutMs/1000,microseconds=(timeoutMs%1000)*1000};
            int ready=select(0,reading?readySet:IntPtr.Zero,reading?IntPtr.Zero:readySet,errorSet,ref timeout);
            if(ready<0)throw new SocketException(WSAGetLastError());
            if(ready==0)throw new IOException(reading?"Guest SSH banner was not received":"Guest channel is not ready");
            if(!reading){
                int socketError,length=4;
                if(getsockopt(raw,SOL_SOCKET,SO_ERROR,out socketError,ref length)!=0)throw new SocketException(WSAGetLastError());
                if(length!=4)throw new SocketException(10022);
                if(socketError!=0)throw new SocketException(socketError);
            }
        }finally{if(readySet!=IntPtr.Zero)Marshal.FreeHGlobal(readySet);if(errorSet!=IntPtr.Zero)Marshal.FreeHGlobal(errorSet);}
    }
    private static IntPtr ConnectGuestSocket(IntPtr raw,byte[] address,int timeoutMs){
        bool transferred=false;
        try{
            uint nonblocking=1;
            if(ioctlsocket(raw,FIONBIO,ref nonblocking)!=0)throw new SocketException(WSAGetLastError());
            if(connect(raw,address,address.Length)!=0){
                int error=WSAGetLastError();if(error!=WSAEWOULDBLOCK)throw new SocketException(error);
                WaitGuestSocket(raw,false,timeoutMs);
            }
            nonblocking=0;
            if(ioctlsocket(raw,FIONBIO,ref nonblocking)!=0)throw new SocketException(WSAGetLastError());
            transferred=true;return raw;
        }finally{if(!transferred)closesocket(raw);}
    }
    private static int ReceiveGuestBanner(IntPtr raw,byte[] banner,int timeoutMs){
        WaitGuestSocket(raw,true,timeoutMs);
        int count=recv(raw,banner,banner.Length,0);
        if(count<0)throw new SocketException(WSAGetLastError());
        if(count==0)throw new IOException("Guest SSH banner was not received");
        return count;
    }
    private static IntPtr OpenGuest(Guid vm) {
        var endpoint = new MuHyperVEndpoint(vm).Serialize(); var address = new byte[36]; for (int i=0;i<36;i++) address[i]=endpoint[i];
        var raw=socket(34,1,1);if(raw==new IntPtr(-1))throw new SocketException(WSAGetLastError());
        return ConnectGuestSocket(raw,address,5000);
    }
    private sealed class Link {
        public TcpClient Client;
        private readonly object gate=new object();private IntPtr guest=new IntPtr(-1);private int users,closing;
        public bool Closing{get{return Interlocked.CompareExchange(ref closing,0,0)!=0;}}
        // Hold the native socket until both pump threads have left their last
        // send/recv call. Closing a socket while another thread still uses its
        // numeric handle permits that handle to be reused for a different socket.
        public bool Attach(IntPtr value){lock(gate){if(Closing)return false;guest=value;users=1;return true;}}
        public bool Reserve(){lock(gate){if(Closing||guest==new IntPtr(-1))return false;users++;return true;}}
        public void Release(){lock(gate){if(users<=0)throw new InvalidOperationException("Channel socket ownership is invalid");users--;if(Closing&&users==0&&guest!=new IntPtr(-1)){closesocket(guest);guest=new IntPtr(-1);}}}
        public void Close(){lock(gate){if(Interlocked.Exchange(ref closing,1)==0){try{Client.Close();}catch{}if(guest!=new IntPtr(-1))shutdown(guest,2);}if(users==0&&guest!=new IntPtr(-1)){closesocket(guest);guest=new IntPtr(-1);}}}
    }
    // The data path does not depend on OpenSSH ProxyCommand handle inheritance.
    // Only the exact VM is reachable and no IP-network fallback is possible.
    private static int Listen(Guid vm,int ownerId) {
        IntPtr startup=Marshal.AllocHGlobal(512);var listener=new TcpListener(IPAddress.Loopback,0);
        var links=new List<Link>();var capacity=new Semaphore(32,32);bool closed=false;long lastBeat=0;
        var authorityReady=new ManualResetEvent(false);MuPowerWatch power=null;
        Action stop=()=>{lock(links){if(closed)return;closed=true;authorityReady.Set();listener.Stop();foreach(var link in links)link.Close();}};
        Action check=()=>{power.Check();long beat=Interlocked.Read(ref lastBeat);if(beat==0||MuPowerWatch.Tick-beat>MuPowerContinuity.AuthorityTimeoutMs){power.AuthorityLost();throw new IOException("Transport authority expired");}};
        try {
            if(WSAStartup(0x0202,startup)!=0)throw new IOException("WinSock initialization failed");
            var owner=Process.GetProcessById(ownerId);
            var watchdog=new Thread(()=>{try{owner.WaitForExit();}catch{}stop();});watchdog.IsBackground=true;watchdog.Start();
            var inputWatch=new Thread(()=>{try{var input=Console.OpenStandardInput();int value=input.ReadByte();if(value==239){if(input.ReadByte()!=187||input.ReadByte()!=191)throw new IOException("Invalid authority encoding");value=input.ReadByte();}while(value>=0){if(value!=46)throw new IOException("Invalid transport authority");Interlocked.Exchange(ref lastBeat,MuPowerWatch.Tick);authorityReady.Set();value=input.ReadByte();}}catch{}finally{stop();}});inputWatch.IsBackground=true;inputWatch.Start();
            if(!authorityReady.WaitOne(10000)||closed)throw new IOException("Transport authority is unavailable");
            power=new MuPowerWatch(stop,()=>{long beat=Interlocked.Read(ref lastBeat);if(beat==0||MuPowerWatch.Tick-beat>MuPowerContinuity.AuthorityTimeoutMs)power.AuthorityLost();});
            check();listener.Start(32);
            Console.WriteLine("{\"port\":"+((IPEndPoint)listener.LocalEndpoint).Port+"}");Console.Out.Flush();
            while(!closed){TcpClient client;try{client=listener.AcceptTcpClient();}catch(SocketException){break;}
                if(!capacity.WaitOne(0)){Diagnostic("capacity");client.Close();continue;}var link=new Link{Client=client};lock(links){links.Add(link);}
                try{StartConnection(()=>{bool attached=false;try{
                    check();IntPtr guest;try{guest=OpenGuest(vm);}catch(SocketException){Diagnostic("guest-connect-socket");throw;}catch(IOException){Diagnostic("guest-connect-timeout");throw;}lock(links){if(closed||!link.Attach(guest)){shutdown(guest,2);closesocket(guest);throw new IOException("Transport closed");}attached=true;}check();var stream=client.GetStream();
                    if(!link.Reserve())throw new IOException("Transport closed");
                    try{var up=new Thread(()=>{try{var b=new byte[65536];int n;while((n=stream.Read(b,0,b.Length))>0){int offset=0;var pin=GCHandle.Alloc(b,GCHandleType.Pinned);try{while(offset<n){check();int sent=send(guest,IntPtr.Add(pin.AddrOfPinnedObject(),offset),n-offset,0);if(sent<=0){if(!link.Closing)Diagnostic("guest-send-error");throw new IOException("Guest closed");}offset+=sent;}}finally{pin.Free();}}}catch{}finally{link.Close();link.Release();}});up.IsBackground=true;up.Start();}catch{link.Release();throw;}
                    var output=new byte[65536];int count;while((count=recv(guest,output,output.Length,0))>0){check();stream.Write(output,0,count);stream.Flush();}
                    if(count<0&&!link.Closing)Diagnostic("guest-recv-error");
                }catch{}finally{link.Close();if(attached)link.Release();lock(links){links.Remove(link);}capacity.Release();}});}
                catch{link.Close();lock(links){links.Remove(link);}capacity.Release();throw;}
            }
            return 0;
        }catch(Exception error){Console.Error.WriteLine("Hyper-V loopback channel: "+error.Message);return 1;}
        finally{stop();if(power!=null)power.Dispose();WSACleanup();Marshal.FreeHGlobal(startup);}
    }
    public static int Main(string[] args) {
        Guid vm;
        int ownerPid;
        if(args.Length==3&&args[0]=="--listen"&&Guid.TryParseExact(args[1],"D",out vm)&&vm!=Guid.Empty&&int.TryParse(args[2],out ownerPid)&&ownerPid>0)return Listen(vm,ownerPid);
        if (args.Length == 1 && args[0] == "--self-test") {
            var address = new MuHyperVEndpoint(new Guid("12345678-1234-4234-8234-123456789012")).Serialize();
            if (address.Size != 36 || address[0] != 34 || address[20] != 0x4a || address[21] != 0x9e) return 1;
            Console.WriteLine("Hyper-V endpoint layout verified"); return 0;
        }
        bool probe = args.Length == 2 && args[1] == "--probe";
        if (!probe || !Guid.TryParseExact(args[0], "D", out vm) || vm == Guid.Empty) {
            Console.Error.WriteLine("An exact VM GUID is required"); return 64;
        }
        IntPtr raw = new IntPtr(-1); IntPtr startup = Marshal.AllocHGlobal(512);
        Action close = () => { var value = Interlocked.Exchange(ref raw, new IntPtr(-1)); if (value != new IntPtr(-1)) closesocket(value); };
        try {
            if (WSAStartup(0x0202, startup) != 0) throw new IOException("WinSock initialization failed");
            raw = OpenGuest(vm);
            Console.Error.WriteLine("Hyper-V connected");var banner=new byte[1024];int count=ReceiveGuestBanner(raw,banner,3000);
            Console.Write(System.Text.Encoding.ASCII.GetString(banner, 0, Math.Max(0, count)));
            return 0;
        } catch (Exception failure) {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "channel-errors.log"), DateTime.UtcNow.ToString("o") + " " + failure.GetType().Name + ": " + failure.Message + Environment.NewLine); } catch { }
            Console.Error.WriteLine("Hyper-V channel: " + failure.Message); return 1;
        }
        finally { close(); WSACleanup(); Marshal.FreeHGlobal(startup); }
    }
}
