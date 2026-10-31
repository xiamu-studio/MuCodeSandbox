import {useState} from 'react';
import {request} from '../api.ts';
import {Button,Notice} from '../components.tsx';

type EventCode='capacity'|'guest-connect-socket'|'guest-connect-timeout'|'guest-send-error'|'guest-recv-error';
type Diagnostics={events:{at:string;code:EventCode}[];full:boolean};
const labels:Record<EventCode,string>={capacity:'管理通道连接数达到上限','guest-connect-socket':'连接虚拟机管理通道失败','guest-connect-timeout':'连接虚拟机管理通道超时','guest-send-error':'向虚拟机发送数据失败','guest-recv-error':'从虚拟机接收数据失败'};

export default function WindowsChannelDiagnostics(){
 const [result,setResult]=useState<Diagnostics|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function read(){setBusy(true);setError('');try{setResult(await request<Diagnostics>('/windows/channel-diagnostics'));}catch(e){setResult(null);setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="panel-width"><h3>管理通道诊断</h3><p className="muted">显示本机最近的有限分类记录，不含地址或用户内容；记录不区分环境，也不能单独确定故障原因。</p><Button disabled={busy} onClick={()=>void read()}>{busy?'读取中…':'读取通道记录'}</Button>{error&&<Notice kind="error">读取通道记录失败：{error}</Notice>}{result&&<>{result.full&&<Notice kind="error">记录已达到容量上限，较新的事件可能未保存。</Notice>}{result.events.length?<ul>{result.events.map((event,index)=><li key={`${event.at}-${index}`}>{new Date(event.at).toLocaleString('zh-CN',{hour12:false})} · {labels[event.code]}</li>)}</ul>:<p className="muted">没有已保存的分类记录；这不代表通道没有发生故障。</p>}</>}</section>;
}
