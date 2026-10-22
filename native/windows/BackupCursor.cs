// Bounded read cursor. A successful read never grants write/seek authority.
// The broker owns the source handle and closes it on release, expiry or fencing.
public sealed class MuBackupReadCursor:IDisposable {
    public const int ChunkBytes=32768;
    private readonly Stream source;
    private readonly Action check;
    private readonly Stopwatch lifetime=Stopwatch.StartNew(),idle=Stopwatch.StartNew();
    private bool closed;
    public readonly long Length;
    public long Offset {get;private set;}
    public MuBackupReadCursor(Stream input,Action guard){
        if(input==null||!input.CanRead||!input.CanSeek||input.Length<1||input.Position!=0)throw new ArgumentException("A pinned nonempty disk stream is required");
        source=input;Length=input.Length;check=guard??(()=>{});
    }
    public bool Expired {get{lock(this)return closed||idle.ElapsedMilliseconds>60000||lifetime.ElapsedMilliseconds>3600000;}}
    public byte[] Read(long offset){
        lock(this){
            if(Expired)throw new IOException("Backup read session expired");check();
            if(offset!=Offset||offset<0||offset>=Length||source.Position!=Offset||source.Length!=Length)throw new ArgumentException("Backup reads must consume the exact next offset");
            var bytes=new byte[(int)Math.Min((long)ChunkBytes,Length-Offset)];
            try{int count=0,read;while(count<bytes.Length&&(read=source.Read(bytes,count,bytes.Length-count))>0)count+=read;if(count!=bytes.Length)throw new IOException("Pinned disk read was incomplete");check();Offset=checked(Offset+bytes.Length);idle.Restart();return bytes;}catch{Array.Clear(bytes,0,bytes.Length);throw;}
        }
    }
    public void Dispose(){lock(this){if(closed)return;closed=true;source.Dispose();}}
}
