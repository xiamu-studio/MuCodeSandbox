import {useEffect,useMemo,useState} from 'react';
import {Clock3} from 'lucide-react';

// Display the current instant in the environment's configured zone. This is a
// UI clock, not a VM clock audit; it never reads a guest process or website.
export default function GuestTimezoneClock({timezone,active=true}:{timezone?:string;active?:boolean}){
 const [now,setNow]=useState(()=>Date.now());
 const formatters=useMemo(()=>{
  if(!timezone)return null;
  try{return {
   compact:new Intl.DateTimeFormat('en-US',{timeZone:timezone,month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'}),
   full:new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}),
  };}catch{return null;}
 },[timezone]);
 useEffect(()=>{
  if(!active||!formatters)return;
  let timer:ReturnType<typeof setInterval>|undefined;
  const resume=()=>{
   clearInterval(timer);
   if(document.hidden)return;
   setNow(Date.now());timer=setInterval(()=>setNow(Date.now()),1000);
  };
  document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);window.addEventListener('pageshow',resume);resume();
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume);window.removeEventListener('pageshow',resume);};
 },[active,formatters]);
 if(!formatters)return <div className="guest-timezone-clock clock-unavailable" role="timer" aria-label="沙箱时区时间" title={timezone?`沙箱时区不可用：${timezone}`:'等待确认沙箱时区'}><Clock3 size={13} aria-hidden="true"/><span>{timezone?'时区不可用':'时区待确认'}</span></div>;
 const date=new Date(now),parts=Object.fromEntries(formatters.compact.formatToParts(date).map(part=>[part.type,part.value])),weekdayZh=formatters.full.formatToParts(date).find(part=>part.type==='weekday')!.value;
 return <div className="guest-timezone-clock" role="timer" aria-label="沙箱时区时间" aria-live="off" title={`${timezone} · ${formatters.full.format(date)} · ${parts.weekday}\n按沙箱配置时区显示，使用本机时钟换算`}>
  <Clock3 size={13} aria-hidden="true"/><time dateTime={date.toISOString()}><span className="guest-clock-date">{parts.month}/{parts.day} </span><span className="guest-clock-weekday-long">{weekdayZh} {parts.weekday} </span><span className="guest-clock-weekday-short">{weekdayZh.replace('星期','周')} {parts.weekday.slice(0,3)} </span>{parts.hour}:{parts.minute}:{parts.second}</time><span className="guest-clock-zone">{parts.timeZoneName}</span>
 </div>;
}
