using System;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;

// Pure policy for a plan already stored in the protected restore journal.
// It never scans or authorizes an arbitrary existing table on its own.
public static class MuOriginPreparation {
    private static void Fields(Dictionary<string,object> value,params string[] fields){if(value==null||value.Count!=fields.Length||value.Keys.Any(key=>!fields.Contains(key)))throw new UnauthorizedAccessException("Origin preparation fields rejected");}
    private static void Identity(object raw){
        var value=raw as Dictionary<string,object>;Fields(value,"fileId","birthFileTime");var id=value["fileId"] as string;var time=value["birthFileTime"] as string;long parsed;
        if(id==null||id.Length!=24||id.All(c=>c=='0')||id.Any(c=>!(c>='0'&&c<='9'||c>='a'&&c<='f'))||time==null||time.Length>19||!long.TryParse(time,NumberStyles.None,CultureInfo.InvariantCulture,out parsed)||parsed<1||parsed.ToString(CultureInfo.InvariantCulture)!=time)throw new UnauthorizedAccessException("Origin preparation identity rejected");
    }
    public static bool Same(object a,object b){Identity(a);Identity(b);var x=(Dictionary<string,object>)a;var y=(Dictionary<string,object>)b;return (string)x["fileId"]==(string)y["fileId"]&&(string)x["birthFileTime"]==(string)y["birthFileTime"];}
    public static void Validate(Dictionary<string,object> plan){
        Fields(plan,"version","epoch","rootFile","directoryFile","storeFile");Guid epoch;var text=plan["epoch"] as string;
        if(!(plan["version"] is int)||(int)plan["version"]!=1||!Guid.TryParseExact(text,"D",out epoch)||epoch==Guid.Empty||epoch.ToString("D")!=text)throw new UnauthorizedAccessException("Origin preparation version rejected");Identity(plan["rootFile"]);
        if((plan["directoryFile"]==null)!=(plan["storeFile"]==null))throw new UnauthorizedAccessException("Origin preparation binding is incomplete");
        if(plan["storeFile"]!=null){Identity(plan["directoryFile"]);Identity(plan["storeFile"]);if(Same(plan["rootFile"],plan["directoryFile"])||Same(plan["rootFile"],plan["storeFile"])||Same(plan["directoryFile"],plan["storeFile"]))throw new UnauthorizedAccessException("Origin preparation objects overlap");}
    }
    public static Dictionary<string,object> Bind(Dictionary<string,object> plan,Dictionary<string,object> root,Dictionary<string,object> directory,Dictionary<string,object> store){
        Validate(plan);if(!Same(plan["rootFile"],root))throw new UnauthorizedAccessException("Origin preparation root changed");
        if(plan["storeFile"]!=null&&(!Same(plan["directoryFile"],directory)||!Same(plan["storeFile"],store)))throw new UnauthorizedAccessException("Origin preparation files changed; preserved");
        var bound=new Dictionary<string,object>(plan);bound["directoryFile"]=directory;bound["storeFile"]=store;Validate(bound);return bound;
    }
}
