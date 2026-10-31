param([string]$Channel)
$ErrorActionPreference='Stop'
$source=@'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
public static class ChannelConnectFixture {
 [DllImport("Ws2_32.dll")] static extern IntPtr socket(int family,int type,int protocol);
 [DllImport("Ws2_32.dll")] static extern int closesocket(IntPtr socket);
 [DllImport("Ws2_32.dll")] static extern int getsockopt(IntPtr socket,int level,int option,out int value,ref int length);
 [DllImport("Ws2_32.dll")] static extern int setsockopt(IntPtr socket,int level,int option,ref int value,int length);
 [DllImport("Ws2_32.dll")] static extern int recv(IntPtr socket,[Out] byte[] data,int length,int flags);
 [DllImport("Ws2_32.dll")] static extern int WSAGetLastError();
 static bool Valid(IntPtr value){int type,length=4;return getsockopt(value,0xffff,0x1008,out type,ref length)==0;}
 static byte[] Address(int port){var value=new IPEndPoint(IPAddress.Loopback,port).Serialize();var bytes=new byte[value.Size];for(int i=0;i<bytes.Length;i++)bytes[i]=value[i];return bytes;}
 static object Call(MethodInfo method,params object[] args){try{return method.Invoke(null,args);}catch(TargetInvocationException error){throw error.InnerException;}}
 static void Require(bool value,string message){if(!value)throw new Exception(message);}
 public static void Check(string file){
  var type=Assembly.LoadFile(file).GetType("MuHyperVChannel");var flags=BindingFlags.Static|BindingFlags.NonPublic;
  var connect=type.GetMethod("ConnectGuestSocket",flags);var banner=type.GetMethod("ReceiveGuestBanner",flags);
  Require(connect!=null&&banner!=null,"Production connection methods not found");
  var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;
  IntPtr raw=new IntPtr(-1);TcpClient peer=null;Thread sender=null;
  try{
   raw=socket(2,1,6);Require(raw!=new IntPtr(-1),"Native fixture socket unavailable");
   try{Require((IntPtr)Call(connect,raw,Address(port),1000)==raw&&Valid(raw),"Connected socket ownership not transferred");}catch(Exception error){throw new Exception("Loopback connect phase: "+error.Message);}
   peer=listener.AcceptTcpClient();
   bool timedOut=false;try{Call(banner,raw,new byte[64],60);}catch(IOException error){timedOut=error.Message=="Guest SSH banner was not received";}
   Require(timedOut&&Valid(raw),"Read deadline closed its caller-owned socket or returned a false banner");
   int deadline=2000;Require(setsockopt(raw,0xffff,0x1006,ref deadline,4)==0,"Fixture receive deadline unavailable");
   sender=new Thread(()=>{Thread.Sleep(80);peer.GetStream().WriteByte(83);});sender.IsBackground=true;sender.Start();
   var data=new byte[1];int count=recv(raw,data,1,0);Require(sender.Join(2000),"Fixture sender did not finish");
   Require(count==1&&data[0]==83,"Production connector did not restore blocking receive mode");
   peer.GetStream().WriteByte(72);var next=new byte[8];Require((int)Call(banner,raw,next,500)==1&&next[0]==72,"Production banner read lost data");
   peer.Close();peer=null;bool eof=false;try{Call(banner,raw,new byte[8],500);}catch(IOException){eof=true;}
   Require(eof&&Valid(raw),"EOF was reported as a successful banner or closed another owner's socket");
  }finally{if(sender!=null)sender.Join(2000);if(peer!=null)peer.Close();if(raw!=new IntPtr(-1))closesocket(raw);listener.Stop();}
  var refused=socket(2,1,6);bool refusedError=false;
  try{Call(connect,refused,Address(port),5000);}catch(SocketException error){refusedError=error.SocketErrorCode==SocketError.ConnectionRefused;}catch(Exception error){throw new Exception("Refused connect phase: "+error.Message);}
  Require(refusedError&&!Valid(refused),"Connection refusal lost its native error or leaked the owned socket");
  var invalid=socket(2,1,6);bool invalidError=false;
  try{Call(connect,invalid,new byte[0],500);}catch(SocketException){invalidError=true;}
  Require(invalidError&&!Valid(invalid),"Malformed native address leaked the owned socket");
 }
}
'@
Add-Type -TypeDefinition $source
[ChannelConnectFixture]::Check($Channel)
Write-Output 'Production native connect, blocking mode, banner deadline, EOF and failed-socket cleanup verified'
