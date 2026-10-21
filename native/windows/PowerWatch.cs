// Shared by the protected broker and each transport. No power settings are
// changed. OS notifications and checks before forwarding close the old epoch.
public static class MuPowerContinuity {
    public const long MaxGapMs=5000,AuthorityTimeoutMs=2500,BiasToleranceTicks=1000000;
    public static string Check(long before,long after,long active,long wall,long previousTick,long previousWall,long originMaxBias){
        if(before<0||after<before||active<0||after>long.MaxValue/10000||after-before>1000)return "monitor-unavailable";
        if(after<previousTick||after-previousTick>MaxGapMs)return "monitor-gap";
        if(before*10000-active-originMaxBias>BiasToleranceTicks)return "resume";
        long elapsed=after-previousTick,wallElapsed=(wall-previousWall)/10000;
        if(wallElapsed<elapsed-2000||wallElapsed>elapsed+2000)return "clock-change";
        return null;
    }
}
public sealed class MuPowerWatch:IDisposable {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint NotifyCallback(IntPtr context,uint type,IntPtr setting);
    [StructLayout(LayoutKind.Sequential)] private struct Subscription {public IntPtr Callback,Context;}
    [DllImport("powrprof.dll")] private static extern uint PowerRegisterSuspendResumeNotification(uint flags,IntPtr recipient,out IntPtr registration);
    [DllImport("powrprof.dll")] private static extern uint PowerUnregisterSuspendResumeNotification(IntPtr registration);
    [DllImport("kernel32.dll")] private static extern ulong GetTickCount64();
    [DllImport("kernelbase.dll")] private static extern void QueryUnbiasedInterruptTimePrecise(out ulong active);
    private static readonly System.Collections.Generic.List<MuPowerWatch> RetainedRegistrations=new System.Collections.Generic.List<MuPowerWatch>();
    private readonly object gate=new object();private readonly Action onTrip,onTick;
    private readonly ManualResetEvent done=new ManualResetEvent(false);private readonly NotifyCallback callback;
    private IntPtr recipient,registration;private Thread watcher;private int disposed;
    private long previousTick,previousWall,originMaxBias;private string issue;
    public string Issue {get{return Interlocked.CompareExchange(ref issue,null,null);}}
    public bool Fenced {get{return Issue!=null;}}
    public static long Tick {get{ulong value=GetTickCount64();if(value>long.MaxValue/10000)throw new IOException("Power clock is unavailable");return (long)value;}}
    private static void Sample(out long before,out long after,out long active,out long wall){
        before=Tick;ulong value;QueryUnbiasedInterruptTimePrecise(out value);after=Tick;wall=DateTime.UtcNow.Ticks;
        if(value>long.MaxValue)throw new IOException("Power clock is unavailable");active=(long)value;
    }
    public MuPowerWatch(Action trip,Action tick=null){
        if(trip==null)throw new ArgumentNullException("trip");onTrip=trip;onTick=tick;callback=Notify;
        long before,after,active,wall;Sample(out before,out after,out active,out wall);
        if(after<before||after-before>1000)throw new IOException("Initial power clock is unavailable");
        previousTick=after;previousWall=wall;originMaxBias=after*10000-active;
        try{
            var subscription=new Subscription{Callback=Marshal.GetFunctionPointerForDelegate(callback),Context=IntPtr.Zero};recipient=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Subscription)));Marshal.StructureToPtr(subscription,recipient,false);
            uint result=PowerRegisterSuspendResumeNotification(2,recipient,out registration);if(result!=0)throw new System.ComponentModel.Win32Exception((int)result,"Power notification registration failed");
            Check();watcher=new Thread(Watch);watcher.IsBackground=true;watcher.Start();
        }catch{Dispose();throw;}
    }
    private uint Notify(IntPtr context,uint type,IntPtr setting){
        if(Interlocked.CompareExchange(ref disposed,0,0)==0){if(type==4)Trip("suspend");else if(type==7||type==18)Trip("resume");}return 0;
    }
    private void Trip(string reason){if(Interlocked.CompareExchange(ref issue,reason,null)==null)try{onTrip();}catch{}}
    public void AuthorityLost(){Trip("authority-stalled");}
    public void Check(){
        if(Interlocked.CompareExchange(ref disposed,0,0)!=0)throw new ObjectDisposedException("Power watch");
        if(!Fenced)try{string reason;lock(gate){long before,after,active,wall;Sample(out before,out after,out active,out wall);reason=MuPowerContinuity.Check(before,after,active,wall,previousTick,previousWall,originMaxBias);previousTick=after;previousWall=wall;}if(reason!=null)Trip(reason);}catch{Trip("monitor-unavailable");}
        if(Fenced)throw new IOException("Power epoch is closed");
    }
    private void Watch(){while(!done.WaitOne(250)){try{Check();if(onTick!=null)onTick();}catch{if(!Fenced)Trip("monitor-unavailable");}if(Fenced)break;}}
    public void Dispose(){
        if(Interlocked.Exchange(ref disposed,1)!=0)return;done.Set();if(watcher!=null&&Thread.CurrentThread!=watcher)watcher.Join(1000);
        if(registration!=IntPtr.Zero&&PowerUnregisterSuspendResumeNotification(registration)!=0){lock(RetainedRegistrations)RetainedRegistrations.Add(this);return;}
        registration=IntPtr.Zero;if(recipient!=IntPtr.Zero){Marshal.FreeHGlobal(recipient);recipient=IntPtr.Zero;}GC.KeepAlive(callback);
    }
}
