using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Two fixed slots in the already pinned protected session file. No per-write
// filesystem object is created, adopted or deleted. A commit marker is written
// only after the complete header/payload has been flushed.
public sealed partial class MuRestoreOriginStore {
    internal const int SlotBytes=1048576,HeaderBytes=80,FooterBytes=64;
    private static readonly byte[] FrameMagic=Encoding.ASCII.GetBytes("MUORIG03"),CommitMagic=Encoding.ASCII.GetBytes("MUCOMMIT");
    private readonly Action<string> checkpoint;
    private bool writingFrame;
    private sealed class Row {public string Text,Nonce;public bool Accepted;}
    private sealed class Frame {public int Slot;public long Revision;public string Epoch,Payload;public Dictionary<string,Row> Rows;}
    private static JavaScriptSerializer FrameJson(){return new JavaScriptSerializer{MaxJsonLength=SlotBytes,RecursionLimit=12};}
    private static byte[] HashBytes(byte[] bytes){using(var sha=SHA256.Create())return sha.ComputeHash(bytes);}
    private static bool SameBytes(byte[] a,byte[] b){return a.SequenceEqual(b);}
    private static void Fields(Dictionary<string,object> value,params string[] fields){if(value==null||value.Count!=fields.Length||value.Keys.Any(key=>!fields.Contains(key)))throw new UnauthorizedAccessException("Origin table fields rejected");}
    private static string StringField(Dictionary<string,object> value,string key){object item;if(!value.TryGetValue(key,out item)||!(item is string))throw new UnauthorizedAccessException("Origin table string rejected");return (string)item;}
    private static void SameIdentity(object raw,Dictionary<string,object> actual){var expected=raw as Dictionary<string,object>;Fields(expected,"fileId","birthFileTime");if(StringField(expected,"fileId")!=(string)actual["fileId"]||StringField(expected,"birthFileTime")!=(string)actual["birthFileTime"])throw new UnauthorizedAccessException("Origin table was copied or its root changed");}
    private FileStream Data(){return new FileStream(new SafeFileHandle(sessionLock.DangerousGetHandle(),false),FileAccess.ReadWrite);}
    private void Point(string name){if(checkpoint!=null)checkpoint(name);}
    private void InitializeFrames(){
        if(preparation!=null){InitializePreparedFrames();return;}
        using(var data=Data()){
            if(data.Length!=0){LoadFrame(data);return;}
            if(requireExisting)throw new IOException("Existing origin table is empty; not initialized by a read/update session");
            // A torn first initialization is deliberately not guessed empty:
            // a nonempty file with no valid slot remains preserved/fenced.
            data.SetLength(2L*SlotBytes);data.Flush(true);Point("initialized-length");
            string epoch=Guid.NewGuid().ToString("D");var rows=new Dictionary<string,Row>();
            WriteFrame(data,0,1,EncodeRows(rows,epoch),epoch);WriteFrame(data,1,2,EncodeRows(rows,epoch),epoch);
        }
    }
    private void InitializePreparedFrames(){
        using(var data=Data()){
            var bound=MuOriginPreparation.Bind(preparation,RootIdentity,CaptureIdentity(directoryHandle),CaptureIdentity(sessionLock));
            if(preparation["storeFile"]==null){if(data.Length!=0)throw new IOException("Unbound initialization file is not empty; preserved");bindPreparation(bound);preparation=bound;Point("initialization-bound");}
            if(data.Length>2L*SlotBytes)throw new IOException("Initialization length changed; preserved");
            string epoch=(string)preparation["epoch"],payload=EncodeRows(new Dictionary<string,Row>(),epoch);var expected=new byte[2*SlotBytes];
            foreach(int slot in new[]{0,1}){var image=FrameImage(slot+1,payload,epoch);Buffer.BlockCopy(image,0,expected,slot*SlotBytes,SlotBytes);}
            if(data.Length!=0){var actual=ReadAt(data,0,(int)data.Length);if(actual==null||actual.Where((value,index)=>value!=0&&value!=expected[index]).Any())throw new IOException("Existing bytes are not this witnessed empty initialization; preserved");}
            data.SetLength(2L*SlotBytes);data.Flush(true);Point("initialized-length");WriteFrame(data,0,1,payload,epoch);WriteFrame(data,1,2,payload,epoch);
            var ready=LoadFrame(data);if(ready.Epoch!=epoch||ready.Revision!=2||ready.Rows.Count!=0)throw new IOException("Initial empty table is not confirmed");Point("initialization-ready");completePreparation();Point("initialization-completed");
        }
    }
    private string EncodeRows(Dictionary<string,Row> rows,string epoch){
        if(rows.Count>32)throw new IOException("Origin table quota exceeded");var entries=new Dictionary<string,object>();
        foreach(var pair in rows.OrderBy(pair=>pair.Key,StringComparer.Ordinal))entries.Add(pair.Key,new Dictionary<string,object>{{"text",pair.Value.Text},{"nonce",pair.Value.Nonce},{"accepted",pair.Value.Accepted}});
        return FrameJson().Serialize(new Dictionary<string,object>{{"format",3},{"kind","standalone-origin-table"},{"ownerSid",sid},{"rootFile",RootIdentity},{"storeFile",CaptureIdentity(sessionLock)},{"epoch",epoch},{"entries",entries}});
    }
    private Frame DecodeRows(string text,int slot,long revision,string epoch){
        Dictionary<string,object> table;try{table=FrameJson().DeserializeObject(text) as Dictionary<string,object>;}catch(Exception error){throw new IOException("Origin table payload invalid",error);}
        Fields(table,"format","kind","ownerSid","rootFile","storeFile","epoch","entries");
        if(!(table["format"] is int)||(int)table["format"]!=3||StringField(table,"kind")!="standalone-origin-table"||StringField(table,"ownerSid")!=sid||StringField(table,"epoch")!=epoch)throw new UnauthorizedAccessException("Origin table authority rejected");
        Id(epoch);SameIdentity(table["rootFile"],RootIdentity);SameIdentity(table["storeFile"],CaptureIdentity(sessionLock));
        var entries=table["entries"] as Dictionary<string,object>;if(entries==null||entries.Count>32)throw new UnauthorizedAccessException("Origin table entries rejected");var rows=new Dictionary<string,Row>();
        foreach(var pair in entries){Id(pair.Key);var value=pair.Value as Dictionary<string,object>;Fields(value,"text","nonce","accepted");if(!(value["accepted"] is bool))throw new UnauthorizedAccessException("Origin acceptance type rejected");string proofText=StringField(value,"text"),nonce=StringField(value,"nonce");Id(nonce);
            if(Encoding.UTF8.GetByteCount(proofText)>MuRestoreOriginProof.MaxBytes)throw new UnauthorizedAccessException("Origin row exceeds bound");
            var raw=FrameJson().DeserializeObject(proofText) as Dictionary<string,object>;if(raw==null)throw new UnauthorizedAccessException("Origin row invalid");string platform=StringField(raw,"platformId");var proof=MuRestoreOriginProof.Parse(proofText,sid,pair.Key,platform);Binding(proof,pair.Key,platform);rows.Add(pair.Key,new Row{Text=proofText,Nonce=nonce,Accepted=(bool)value["accepted"]});}
        if(FrameJson().Serialize(table)!=text)throw new UnauthorizedAccessException("Origin table encoding rejected");return new Frame{Slot=slot,Revision=revision,Epoch=epoch,Payload=text,Rows=rows};
    }
    private static byte[] ReadAt(FileStream data,long offset,int count){data.Position=offset;var bytes=new byte[count];int n,done=0;while(done<count&&(n=data.Read(bytes,done,count-done))>0)done+=n;return done==count?bytes:null;}
    private Frame ReadFrame(FileStream data,int slot){
        long offset=(long)slot*SlotBytes;var head=ReadAt(data,offset,HeaderBytes);var tail=ReadAt(data,offset+SlotBytes-FooterBytes,FooterBytes);if(head==null||tail==null||!SameBytes(tail.Take(8).ToArray(),CommitMagic))return null;
        if(!SameBytes(head.Take(8).ToArray(),FrameMagic))throw new IOException("Unknown committed origin table format");
        long revision=BitConverter.ToInt64(head,8);int length=BitConverter.ToInt32(head,16);
        if(revision<1||revision>=long.MaxValue||length<1||length>SlotBytes-HeaderBytes-FooterBytes||BitConverter.ToInt64(tail,8)!=revision||!SameBytes(head.Skip(24).Take(32).ToArray(),tail.Skip(16).Take(32).ToArray())||!SameBytes(head.Skip(56).Take(16).ToArray(),tail.Skip(48).Take(16).ToArray()))return null;
        if(head.Skip(20).Take(4).Any(value=>value!=0)||head.Skip(72).Take(8).Any(value=>value!=0))throw new IOException("Unknown committed origin header flags");
        var payload=ReadAt(data,offset+HeaderBytes,length);if(payload==null||!SameBytes(HashBytes(payload),head.Skip(24).Take(32).ToArray()))return null;
        string text=new UTF8Encoding(false,true).GetString(payload),epoch=new Guid(head.Skip(56).Take(16).ToArray()).ToString("D");return DecodeRows(text,slot,revision,epoch);
    }
    private Frame LoadFrame(FileStream data){
        Inventory();if(data.Length!=2L*SlotBytes)throw new IOException("Origin table length changed");var a=ReadFrame(data,0);var b=ReadFrame(data,1);
        if(a==null&&b==null)throw new IOException("No complete origin table slot remains; all data preserved");
        if(a!=null&&b!=null&&(a.Epoch!=b.Epoch||a.Revision==b.Revision&&a.Payload!=b.Payload))throw new UnauthorizedAccessException("Origin table slots conflict");
        return a==null?b:b==null?a:a.Revision>=b.Revision?a:b;
    }
    private void WriteFrame(FileStream data,int slot,long revision,string payload,string epoch){
        if(writingFrame)throw new IOException("Recursive origin commit rejected");writingFrame=true;
        try{
        var bytes=new UTF8Encoding(false,true).GetBytes(payload);if(bytes.Length<1||bytes.Length>SlotBytes-HeaderBytes-FooterBytes)throw new IOException("Origin table payload exceeds bound");
        var frame=FrameImage(revision,payload,epoch);var head=frame.Take(HeaderBytes).ToArray();var tail=frame.Skip(SlotBytes-FooterBytes).ToArray();
        long offset=(long)slot*SlotBytes;data.Position=offset+SlotBytes-FooterBytes;data.Write(new byte[FooterBytes],0,FooterBytes);data.Flush(true);Point("frame-invalidated");
        data.Position=offset;data.Write(head,0,head.Length);data.Write(bytes,0,bytes.Length);data.Flush(true);Point("frame-data");
        data.Position=offset+SlotBytes-FooterBytes;data.Write(tail,0,tail.Length);data.Flush(true);Point("frame-committed");
        }finally{writingFrame=false;}
    }
    private byte[] FrameImage(long revision,string payload,string epoch){
        var bytes=new UTF8Encoding(false,true).GetBytes(payload);if(bytes.Length<1||bytes.Length>SlotBytes-HeaderBytes-FooterBytes)throw new IOException("Origin table payload exceeds bound");
        byte[] hash=HashBytes(bytes),guid=new Guid(epoch).ToByteArray(),head=new byte[HeaderBytes],tail=new byte[FooterBytes];
        Buffer.BlockCopy(FrameMagic,0,head,0,8);Buffer.BlockCopy(BitConverter.GetBytes(revision),0,head,8,8);Buffer.BlockCopy(BitConverter.GetBytes(bytes.Length),0,head,16,4);Buffer.BlockCopy(hash,0,head,24,32);Buffer.BlockCopy(guid,0,head,56,16);
        Buffer.BlockCopy(CommitMagic,0,tail,0,8);Buffer.BlockCopy(BitConverter.GetBytes(revision),0,tail,8,8);Buffer.BlockCopy(hash,0,tail,16,32);Buffer.BlockCopy(guid,0,tail,48,16);
        var frame=new byte[SlotBytes];Buffer.BlockCopy(head,0,frame,0,HeaderBytes);Buffer.BlockCopy(bytes,0,frame,HeaderBytes,bytes.Length);Buffer.BlockCopy(tail,0,frame,SlotBytes-FooterBytes,FooterBytes);return frame;
    }
    private void Commit(Frame expected,Dictionary<string,Row> rows){
        using(var data=Data()){var current=LoadFrame(data);if(current.Revision!=expected.Revision||current.Epoch!=expected.Epoch||current.Payload!=expected.Payload)throw new IOException("Origin table changed during verification");if(current.Revision>=long.MaxValue-1)throw new IOException("Origin table revision exhausted");
            string text=EncodeRows(rows,current.Epoch);DecodeRows(text,1-current.Slot,current.Revision+1,current.Epoch);WriteFrame(data,1-current.Slot,current.Revision+1,text,current.Epoch);}
    }
    private Frame Load(){using(var data=Data())return LoadFrame(data);}
    private string RowToken(Frame frame,string id,string platform,Row row){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n",new[]{sid,id,platform,frame.Epoch,row.Nonce,row.Text,row.Accepted?"accepted":"pending"})))).Replace("-","").ToLowerInvariant();}
    private Dictionary<string,object> ExpectedFrame(MuRestoreOriginSnapshot expected,string id,string platform){if(expected==null||expected.Token==null||expected.Token.Length!=64||expected.Token.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f')))throw new UnauthorizedAccessException("Origin snapshot token rejected");var proof=MuRestoreOriginProof.Parse(expected.Text,sid,id,platform);Binding(proof,id,platform);return proof;}
    private MuRestoreOriginSnapshot FrameSnapshot(string id,string platform){Id(id);var state=Load();Row row;if(!state.Rows.TryGetValue(id,out row))throw new IOException("Origin receipt is missing");Binding(MuRestoreOriginProof.Parse(row.Text,sid,id,platform),id,platform);return new MuRestoreOriginSnapshot(row.Text,RowToken(state,id,platform,row),row.Accepted);}
    private void PublishFrame(Dictionary<string,object> value,string id,string platform){Id(id);var state=Load();string text=MuRestoreOriginProof.Encode(value,sid,id,platform);Binding(MuRestoreOriginProof.Parse(text,sid,id,platform),id,platform);Row row;if(state.Rows.TryGetValue(id,out row)){if(row.Text!=text)throw new IOException("Existing origin differs; preserved");using(var data=Data())data.Flush(true);return;}var rows=new Dictionary<string,Row>(state.Rows);rows.Add(id,new Row{Text=text,Nonce=Guid.NewGuid().ToString("D")});Commit(state,rows);}
    private void UpdateFrame(MuRestoreOriginSnapshot expected,Dictionary<string,object> value,string operation,string id,string platform,Action<Dictionary<string,object>> verify){
        Id(id);var state=Load();var prior=ExpectedFrame(expected,id,platform);string text=MuRestoreOriginProof.Encode(value,sid,id,platform);var next=MuRestoreOriginProof.Parse(text,sid,id,platform);Binding(next,id,platform);MuRestoreOriginProof.Transition(prior,next,operation,sid,id,platform);if(verify==null)throw new ArgumentNullException("verify");Row row;if(!state.Rows.TryGetValue(id,out row))throw new IOException("Origin receipt missing");
        if(!row.Accepted)throw new UnauthorizedAccessException("Incomplete import origin cannot change lifecycle");
        if(row.Text==text){verify(MuRestoreOriginProof.Parse(text,sid,id,platform));if(FrameSnapshot(id,platform).Token!=RowToken(state,id,platform,row))throw new IOException("Origin changed during retry");using(var data=Data())data.Flush(true);return;}
        if(row.Text!=expected.Text||RowToken(state,id,platform,row)!=expected.Token)throw new IOException("Stale origin snapshot");verify(MuRestoreOriginProof.Parse(text,sid,id,platform));var rows=new Dictionary<string,Row>(state.Rows);rows[id]=new Row{Text=text,Nonce=Guid.NewGuid().ToString("D"),Accepted=true};Commit(state,rows);
    }
    private void AcceptFrame(MuRestoreOriginSnapshot expected,string id,string platform,Action<Dictionary<string,object>> verify){
        Id(id);var state=Load();var proof=ExpectedFrame(expected,id,platform);if(verify==null)throw new ArgumentNullException("verify");Row row;
        if(!state.Rows.TryGetValue(id,out row)||row.Text!=expected.Text)throw new IOException("Original pending import differs; preserved");
        if(!row.Accepted&&RowToken(state,id,platform,row)!=expected.Token)throw new IOException("Stale pending import version");
        verify(proof);
        if(row.Accepted){if(FrameSnapshot(id,platform).Token!=RowToken(state,id,platform,row))throw new IOException("Origin changed during acceptance retry");using(var data=Data())data.Flush(true);return;}
        var rows=new Dictionary<string,Row>(state.Rows);rows[id]=new Row{Text=row.Text,Nonce=Guid.NewGuid().ToString("D"),Accepted=true};Commit(state,rows);
    }
    private bool RetireFrame(MuRestoreOriginSnapshot expected,string id,string platform,Action<Dictionary<string,object>> verify){
        Id(id);var state=Load();ExpectedFrame(expected,id,platform);if(verify==null)throw new ArgumentNullException("verify");Row row;
        if(!state.Rows.TryGetValue(id,out row)){verify(MuRestoreOriginProof.Parse(expected.Text,sid,id,platform));if(Load().Rows.ContainsKey(id))throw new IOException("Origin appeared during retirement");return false;}
        if(row.Text!=expected.Text||RowToken(state,id,platform,row)!=expected.Token)throw new IOException("Stale retirement snapshot");verify(MuRestoreOriginProof.Parse(row.Text,sid,id,platform));var rows=new Dictionary<string,Row>(state.Rows);rows.Remove(id);Commit(state,rows);return true;
    }
}
