param([string]$Channel)
$ErrorActionPreference='Stop'
$source=@'
using System;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class ChannelLifetimeFixture {
 [DllImport("Ws2_32.dll")] static extern IntPtr socket(int family,int type,int protocol);
 [DllImport("Ws2_32.dll")] static extern int getsockopt(IntPtr socket,int level,int option,out int value,ref int length);
 [DllImport("Ws2_32.dll")] static extern int closesocket(IntPtr socket);
 static bool Valid(IntPtr value){int type,len=4;return getsockopt(value,0xffff,0x1008,out type,ref len)==0;}
 public static void Check(string assembly){
  var t=Assembly.LoadFile(assembly).GetType("MuHyperVChannel+Link");var flags=BindingFlags.Public|BindingFlags.Instance;
  var l=Activator.CreateInstance(t,true);t.GetField("Client",flags).SetValue(l,new TcpClient());
  var attach=t.GetMethod("Attach",flags);var reserve=t.GetMethod("Reserve",flags);var close=t.GetMethod("Close",flags);var release=t.GetMethod("Release",flags);
  var s=socket(2,1,6);if(s==new IntPtr(-1))throw new Exception("socket creation failed");
  if(!(bool)attach.Invoke(l,new object[]{s})||!(bool)reserve.Invoke(l,null))throw new Exception("owners not admitted");
  close.Invoke(l,null);close.Invoke(l,null);if(!Valid(s))throw new Exception("socket closed before pumps finished");
  if((bool)reserve.Invoke(l,null))throw new Exception("closed socket admitted new owner");
  release.Invoke(l,null);if(!Valid(s))throw new Exception("socket closed with a pump outstanding");
  release.Invoke(l,null);if(Valid(s))throw new Exception("socket survived both pumps");
  var other=Activator.CreateInstance(t,true);t.GetField("Client",flags).SetValue(other,new TcpClient());close.Invoke(other,null);
  var candidate=socket(2,1,6);try{if((bool)attach.Invoke(other,new object[]{candidate}))throw new Exception("closed link accepted a socket");}finally{closesocket(candidate);}
  for(int i=0;i<30;i++){
   var race=Activator.CreateInstance(t,true);t.GetField("Client",flags).SetValue(race,new TcpClient());var handle=socket(2,1,6);
   if(!(bool)attach.Invoke(race,new object[]{handle})||!(bool)reserve.Invoke(race,null))throw new Exception("race owners not admitted");
   Parallel.Invoke(()=>close.Invoke(race,null),()=>release.Invoke(race,null),()=>release.Invoke(race,null));
   if(Valid(handle))throw new Exception("concurrent close left a socket open");
  }
 }
}
'@
Add-Type -TypeDefinition $source
[ChannelLifetimeFixture]::Check($Channel)
Write-Output 'Channel socket stays owned until both pumps finish'
