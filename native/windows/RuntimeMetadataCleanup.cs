using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Runs with the ordinary application token. Directory handles deny rename/delete
// while descendants are examined; every removal is a leaf or an empty directory.
public static class MuRuntimeMetadataCleanup {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,[Out]byte[] info);
    private sealed class Node:IDisposable {
        public string Path;public SafeFileHandle Handle;public readonly List<Node> Children=new List<Node>();public readonly List<string> Files=new List<string>();
        public void Dispose(){foreach(var child in Children)child.Dispose();if(Handle!=null)Handle.Dispose();}
    }
    private static SafeFileHandle Pin(string path){
        var handle=CreateFile(path,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw new IOException("Cannot pin metadata directory");}
        var info=new byte[52];if(!GetFileInformationByHandle(handle,info)){handle.Dispose();throw new IOException("Cannot inspect metadata directory");}
        var attributes=(FileAttributes)BitConverter.ToUInt32(info,0);
        if((attributes&FileAttributes.ReparsePoint)!=0||(attributes&FileAttributes.Directory)==0){handle.Dispose();throw new IOException("Metadata directory is a reparse point");}
        return handle;
    }
    private static Node ReadTree(string directory,bool reset,bool seed=false){
        var node=new Node{Path=directory,Handle=Pin(directory)};
        try{
            foreach(string entry in Directory.EnumerateFileSystemEntries(directory)){
                string name=System.IO.Path.GetFileName(entry);var attributes=File.GetAttributes(entry);
                if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Metadata reparse entry rejected");
                if((attributes&FileAttributes.Directory)!=0){if(seed||name!="seed")throw new IOException("Unexpected metadata directory; files retained");node.Children.Add(ReadTree(entry,reset,true));}
                else{
                    var allowed=seed?new[]{"meta-data","user-data","network-config"}:new[]{"management","management.pub","host-ed25519","host-ed25519.pub","known_hosts","seed.iso","allocation.json","manifest.json"};
                    if(!allowed.Contains(name)||reset&&name=="manifest.json")throw new IOException("Unexpected metadata file; files retained");node.Files.Add(entry);
                }
            }
            return node;
        }catch{node.Dispose();throw;}
    }
    private static void RemoveTree(Node node,bool keep){
        foreach(var child in node.Children)RemoveTree(child,false);
        foreach(string file in node.Files)File.Delete(file);
        if(!keep){node.Handle.Dispose();Directory.Delete(node.Path,false);}
    }
    public static void Remove(string root,string id,bool reset,bool checkOnly=false){
        Guid value;if(!Guid.TryParseExact(id,"D",out value)||value==Guid.Empty||value.ToString("D")!=id)throw new ArgumentException("Canonical environment ID required");
        string parent=System.IO.Path.GetFullPath(root).TrimEnd('\\'),directory=System.IO.Path.GetFullPath(System.IO.Path.Combine(parent,"mu-win-"+id.Replace("-","")));
        if(parent.Length<4||parent[1]!=':'||System.IO.Path.GetDirectoryName(directory)!=parent)throw new IOException("Metadata removal boundary changed");
        var pins=new List<SafeFileHandle>();
        try{
            string cursor=System.IO.Path.GetPathRoot(directory);pins.Add(Pin(cursor));
            foreach(string part in parent.Substring(cursor.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){cursor=System.IO.Path.Combine(cursor,part);pins.Add(Pin(cursor));}
            try{File.GetAttributes(directory);}catch(DirectoryNotFoundException){return;}catch(FileNotFoundException){return;}
            using(var tree=ReadTree(directory,reset))if(!checkOnly)RemoveTree(tree,reset);
        }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
    }
}
