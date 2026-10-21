public static partial class MuHyperVBroker {
    private static MuPowerWatch PowerGuard;
    private static readonly CancellationTokenSource PowerCancellation=new CancellationTokenSource();
    private static readonly string PowerSession=Guid.NewGuid().ToString("N");
    private static volatile bool PowerCleanupRunning,PowerStopsConfirmed;
    private static void CheckPower(){
        if(PowerGuard==null)throw new MuStorageException("POWER_FENCED","Power monitoring is unavailable; reopen the application");
        try{PowerGuard.Check();}catch{throw new MuStorageException("POWER_FENCED","The previous power epoch is closed; reopen the application");}
    }
    private static object PowerStatus(){
        try{PowerGuard.Check();}catch{}
        return new {session=PowerSession,monitoring=PowerGuard!=null,fenced=PowerGuard==null||PowerGuard.Fenced,issue=PowerGuard==null?"monitor-unavailable":PowerGuard.Issue,cleanupRunning=PowerCleanupRunning,stopsConfirmed=PowerStopsConfirmed};
    }
    private static void PowerTrip(){
        try{PowerCancellation.Cancel();}catch{}foreach(var record in RecordSnapshot())try{CloseChannel(Convert.ToString(record["id"]));}catch{}
        try{File.WriteAllText(Path.Combine(UserRoot,"power-trip.json"),Json().Serialize(new {session=PowerSession,time=DateTime.UtcNow.ToString("o")}));}catch{}
        if(SetupOnly||RecoveryOnly)return;
        PowerCleanupRunning=true;var cleanup=new Thread(()=>{
            while(!Closing.IsCancellationRequested){
                bool confirmed=true;foreach(var record in RecordSnapshot())try{string id=Convert.ToString(record["id"]);lock(VmGate(id))RecoverAllocation(Owned(id));}catch{confirmed=false;}
                if(confirmed){PowerStopsConfirmed=true;break;}if(Closing.Token.WaitHandle.WaitOne(1000))break;
            }PowerCleanupRunning=false;
        });cleanup.IsBackground=true;cleanup.Start();
    }
    private static void StartPowerProtection(){PowerGuard=new MuPowerWatch(PowerTrip);Held.Add(PowerGuard);}
    private static void StartChannelHeartbeat(string id,Process process){
        // A dedicated thread flushes each byte. Buffered/ThreadPool writes can
        // otherwise report completion without delivering an authority heartbeat.
        var pumping=new Thread(()=>{try{while(!Stopping&&!PowerGuard.Fenced&&!process.HasExited){CheckPower();process.StandardInput.BaseStream.WriteByte(46);process.StandardInput.BaseStream.Flush();if(process.WaitForExit(500))break;}}catch(Exception error){try{File.AppendAllText(Path.Combine(UserRoot,"channel-errors.log"),DateTime.UtcNow.ToString("o")+" "+error.GetType().Name+Environment.NewLine);}catch{}}finally{lock(Gate){Process current;if(Channels.TryGetValue(id,out current)&&object.ReferenceEquals(current,process))CloseChannel(id);}}});pumping.IsBackground=true;pumping.Start();
    }
}
