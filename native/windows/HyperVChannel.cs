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
public static class MuHyperVChannel {
    [DllImport("Ws2_32.dll")] private static extern int WSAStartup(ushort version, IntPtr data);
    [DllImport("Ws2_32.dll")] private static extern int WSACleanup();
    [DllImport("Ws2_32.dll")] private static extern IntPtr socket(int family, int type, int protocol);
    [DllImport("Ws2_32.dll")] private static extern int connect(IntPtr socket, byte[] address, int length);
    [DllImport("Ws2_32.dll")] private static extern int send(IntPtr socket, IntPtr data, int count, int flags);
    [DllImport("Ws2_32.dll")] private static extern int recv(IntPtr socket, [Out] byte[] data, int count, int flags);
    [DllImport("Ws2_32.dll")] private static extern int shutdown(IntPtr socket, int how);
    [DllImport("Ws2_32.dll")] private static extern int closesocket(IntPtr socket);
    [DllImport("Ws2_32.dll")] private static extern int WSAGetLastError();
    private static IntPtr OpenGuest(Guid vm) {
        var raw = socket(34, 1, 1); if (raw == new IntPtr(-1)) throw new SocketException(WSAGetLastError());
        var endpoint = new MuHyperVEndpoint(vm).Serialize(); var address = new byte[36]; for (int i=0;i<36;i++) address[i]=endpoint[i];
        int result=-1, error=0; var done=new ManualResetEvent(false);
        var opening=new Thread(()=>{result=connect(raw,address,address.Length);if(result!=0)error=WSAGetLastError();done.Set();}); opening.IsBackground=true;opening.Start();
        if(!done.WaitOne(5000)){closesocket(raw);throw new IOException("Guest channel is not ready");}
        if(result!=0){closesocket(raw);throw new SocketException(error);}return raw;
    }
    private sealed class Link {
        public TcpClient Client; public IntPtr Guest=new IntPtr(-1);
        public void Close(){try{Client.Close();}catch{}var value=Interlocked.Exchange(ref Guest,new IntPtr(-1));if(value!=new IntPtr(-1)){shutdown(value,2);closesocket(value);}}
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
                if(!capacity.WaitOne(0)){client.Close();continue;}var link=new Link{Client=client};lock(links){links.Add(link);}
                ThreadPool.QueueUserWorkItem(_=>{try{
                    check();var guest=OpenGuest(vm);lock(links){if(closed){shutdown(guest,2);closesocket(guest);throw new IOException("Transport closed");}link.Guest=guest;}check();var stream=client.GetStream();
                    var up=new Thread(()=>{try{var b=new byte[65536];int n;while((n=stream.Read(b,0,b.Length))>0){int offset=0;var pin=GCHandle.Alloc(b,GCHandleType.Pinned);try{while(offset<n){check();int sent=send(link.Guest,IntPtr.Add(pin.AddrOfPinnedObject(),offset),n-offset,0);if(sent<=0)throw new IOException("Guest closed");offset+=sent;}}finally{pin.Free();}}}catch{}finally{link.Close();}});up.IsBackground=true;up.Start();
                    var output=new byte[65536];int count;while((count=recv(link.Guest,output,output.Length,0))>0){check();stream.Write(output,0,count);stream.Flush();}
                }catch{}finally{link.Close();lock(links){links.Remove(link);}capacity.Release();}});
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
            Console.Error.WriteLine("Hyper-V connected"); var arrived = new ManualResetEvent(false); int count = 0; var banner = new byte[1024];
            var receiver = new Thread(() => { count = recv(raw, banner, banner.Length, 0); arrived.Set(); }); receiver.IsBackground = true; receiver.Start();
            if (!arrived.WaitOne(3000)) throw new IOException("Guest SSH banner was not received");
            Console.Write(System.Text.Encoding.ASCII.GetString(banner, 0, Math.Max(0, count)));
            return 0;
        } catch (Exception failure) {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "channel-errors.log"), DateTime.UtcNow.ToString("o") + " " + failure.GetType().Name + ": " + failure.Message + Environment.NewLine); } catch { }
            Console.Error.WriteLine("Hyper-V channel: " + failure.Message); return 1;
        }
        finally { close(); WSACleanup(); Marshal.FreeHGlobal(startup); }
    }
}
