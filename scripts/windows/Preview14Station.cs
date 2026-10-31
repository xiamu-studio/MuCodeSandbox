// Installed preview.14 isolated fixture launcher. Creates only a new, noninteractive window
// station; never opens WinSta0/Winlogon or changes an existing object's DACL.
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using System.ComponentModel;using System.Security.Principal;using System.Security.Cryptography;using System.Web.Script.Serialization;using System.Collections.Generic;
public static class MuPreview14Station {
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
   if(Environment.MachineName!="MU-CLEAN-LAB"||!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)||(args.Length!=1&&args.Length!=2)||!System.Text.RegularExpressions.Regex.IsMatch(args[0],"^[a-f0-9]{32}$"))throw new ArgumentException("Isolated installed preview case required");
   bool restored=args.Length==2&&args[1]=="continue-restored";bool diagnostic=args.Length==2&&args[1]=="diagnose-export",resume=args.Length==2&&args[1]=="resume-export";if(args.Length==2&&!diagnostic&&!resume&&!restored)throw new ArgumentException("Unknown fixture phase");
   string id=args[0],directory="C:\\MuLab\\public\\backup-preview14-"+id,client=restored?"C:\\MuLab\\backup-restored-continue.mjs":resume?"C:\\MuLab\\backup-installed-resume.mjs":diagnostic?"C:\\MuLab\\backup-export-diagnostic.mjs":"C:\\MuLab\\backup-preview14.mjs";
   var config=json.Deserialize<Dictionary<string,object>>(File.ReadAllText("C:\\MuLab\\approved\\"+(restored?"preview14-restored-launch-":resume?"preview14-resume-launch-":diagnostic?"preview14-diagnostic-launch-":"preview14-launch-")+id+".json"));var secret=json.Deserialize<Dictionary<string,object>>(File.ReadAllText("C:\\MuLab\\private\\credentials.json"));
   string node=diagnostic||resume||restored?Convert.ToString(config["node"]):"C:\\MuLab\\product\\resources\\node\\node.exe";
   string sid=Convert.ToString(config["sid"]);if(Convert.ToString(secret["user"])!="MuLabUser"||Convert.ToString(config["caseId"])!=id||Hash(client)!=Convert.ToString(config["clientSha256"])||Hash(node)!=Convert.ToString(config["nodeSha256"])||File.Exists(Path.Combine(directory,restored?"restored-owner.json":resume?"resume-owner.json":diagnostic?"diagnostic-owner.json":"owner.json"))||File.Exists(Path.Combine(directory,restored?"restored-result.json":resume?"resume-result.json":diagnostic?"diagnostic-result.json":"upgrade-result.json")))throw new UnauthorizedAccessException("Original fixture identity changed");
   new SecurityIdentifier(sid);uint bytes;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;"+sid+")",1,out sd,out bytes));var sa=new SA{length=Marshal.SizeOf(typeof(SA)),descriptor=sd,inherit=false};
   string stationName="MuPreview14_"+id+(restored?"_restored":resume?"_resume":diagnostic?"_diagnostic":"");station=CreateWindowStation(stationName,1,0x10000000,ref sa);Check(station!=IntPtr.Zero);IntPtr oldStation=GetProcessWindowStation(),oldDesktop=GetThreadDesktop(GetCurrentThreadId());
   try{Check(SetProcessWindowStation(station));desktop=CreateDesktop("Default",IntPtr.Zero,IntPtr.Zero,0,0x10000000,ref sa);Check(desktop!=IntPtr.Zero);}finally{Check(SetProcessWindowStation(oldStation));Check(SetThreadDesktop(oldDesktop));}
   string command="\""+node+"\" --no-warnings \""+client+"\" "+(diagnostic||resume||restored?"":"upgrade ")+id;var startup=new STARTUP{cb=Marshal.SizeOf(typeof(STARTUP)),desktop=stationName+"\\Default",flags=1,show=0};Check(CreateProcessWithLogonW("MuLabUser","MU-CLEAN-LAB",Convert.ToString(secret["userPassword"]),1,node,new StringBuilder(command),0x08000400,IntPtr.Zero,directory,ref startup,out child));
   if(WaitForSingleObject(child.process,1800000U)!=0){Console.WriteLine(json.Serialize(new{complete=false,live=true,pid=child.pid}));return 2;}uint code;Check(GetExitCodeProcess(child.process,out code));Console.WriteLine(json.Serialize(new{complete=code==0,exitCode=code,pid=child.pid,privateStation=true}));return code==0?0:1;
  }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
  finally{if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);if(desktop!=IntPtr.Zero)CloseDesktop(desktop);if(station!=IntPtr.Zero)CloseWindowStation(station);if(sd!=IntPtr.Zero)LocalFree(sd);}
 }
}
