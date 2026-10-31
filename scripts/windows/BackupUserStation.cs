// Disposable cross-user backup fixture launcher. Creates only a new, noninteractive window
// station; never opens WinSta0/Winlogon or changes an existing object's DACL.
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using System.ComponentModel;using System.Security.Principal;using System.Security.Cryptography;using System.Web.Script.Serialization;using System.Collections.Generic;
public static class MuBackupUserStation {
 [StructLayout(LayoutKind.Sequential)]struct SA{public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct STARTUP{public int cb;public string reserved,desktop,title;public int x,y,width,height,xChars,yChars,fill,flags;public short show,reservedBytes;public IntPtr reservedPointer,input,output,error;}
 [StructLayout(LayoutKind.Sequential)]struct PROCESS{public IntPtr process,thread;public uint pid,tid;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowStation(string name,uint flags,uint access,ref SA sa);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SA sa);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",SetLastError=true)]static extern bool SetProcessWindowStation(IntPtr station);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll",SetLastError=true)]static extern bool SetThreadDesktop(IntPtr desktop);
 [DllImport("user32.dll")]static extern bool CloseWindowStation(IntPtr station);
 [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr pointer);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessWithLogonW(string user,string domain,string password,uint logon,string application,StringBuilder command,uint flags,IntPtr environment,string directory,ref STARTUP startup,out PROCESS process);
 static void Check(bool value){if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());}
 static string Hash(string file){using(var input=File.OpenRead(file))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
 public static int Main(string[] args){
  IntPtr sd=IntPtr.Zero,station=IntPtr.Zero,desktop=IntPtr.Zero;PROCESS child=new PROCESS();var json=new JavaScriptSerializer{MaxJsonLength=65536};
  try{
   if(Environment.MachineName!="MU-CLEAN-LAB"||!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)||args.Length!=2||args[0].Length!=32||Array.Exists(args[0].ToCharArray(),c=>!(c>='0'&&c<='9'||c>='a'&&c<='f'))||Array.IndexOf(new[]{"conflict","restore","recover"},args[1])<0)throw new ArgumentException("Typed isolated backup-user phase required");
   string id=args[0];var config=json.Deserialize<Dictionary<string,object>>(File.ReadAllText("C:\\MuLab\\approved\\backup-user-"+id+"-config.json"));var secret=json.Deserialize<Dictionary<string,object>>(File.ReadAllText("C:\\MuLab\\private\\backup-user-"+id+"-credentials.json"));
   string user=Convert.ToString(config["userName"]),sid=Convert.ToString(config["userSid"]),directory=Convert.ToString(config["directory"]),client="C:\\MuLab\\backup-cross-target.mjs",node="C:\\MuLab\\product\\resources\\node\\node.exe";
   if(user!="MuBkp_"+id.Substring(0,8)||Convert.ToString(config["caseId"])!=id||Convert.ToString(secret["caseId"])!=id||Convert.ToString(secret["userSid"])!=sid||directory!="C:\\MuLab\\backup-user-"+id||Hash(client)!=Convert.ToString(config["clientSha256"])||Hash(node)!=Convert.ToString(config["nodeSha256"]))throw new UnauthorizedAccessException("Backup-user identity or inputs changed");
   new SecurityIdentifier(sid);uint bytes;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;"+sid+")",1,out sd,out bytes));var sa=new SA{length=Marshal.SizeOf(typeof(SA)),descriptor=sd,inherit=false};
   string stationName="MuBackup_"+id+"_"+args[1];station=CreateWindowStation(stationName,1,0x10000000,ref sa);Check(station!=IntPtr.Zero);IntPtr oldStation=GetProcessWindowStation(),oldDesktop=GetThreadDesktop(GetCurrentThreadId());
   try{Check(SetProcessWindowStation(station));desktop=CreateDesktop("Default",IntPtr.Zero,IntPtr.Zero,0,0x10000000,ref sa);Check(desktop!=IntPtr.Zero);}finally{Check(SetProcessWindowStation(oldStation));Check(SetThreadDesktop(oldDesktop));}
   string command="\""+node+"\" --no-warnings \""+client+"\" "+id+" "+args[1];var startup=new STARTUP{cb=Marshal.SizeOf(typeof(STARTUP)),desktop=stationName+"\\Default",flags=1,show=0};Check(CreateProcessWithLogonW(user,"MU-CLEAN-LAB",Convert.ToString(secret["password"]),1,node,new StringBuilder(command),0x08000400,IntPtr.Zero,directory,ref startup,out child));
   if(WaitForSingleObject(child.process,1800000U)!=0){Console.WriteLine(json.Serialize(new{complete=false,live=true,pid=child.pid,privateStation=true}));return 2;}uint code;Check(GetExitCodeProcess(child.process,out code));Console.WriteLine(json.Serialize(new{complete=code==0,exitCode=code,pid=child.pid,privateStation=true,existingDesktopChanged=false}));return code==0?0:1;
  }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
  finally{if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);if(desktop!=IntPtr.Zero)CloseDesktop(desktop);if(station!=IntPtr.Zero)CloseWindowStation(station);if(sd!=IntPtr.Zero)LocalFree(sd);}
 }
}