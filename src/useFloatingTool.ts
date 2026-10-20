import {useLayoutEffect,useRef,useState,type RefObject,type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent,type CSSProperties} from 'react';

interface Bounds {x:number;y:number;width:number;height?:number}
export function useFloatingTool(ref:RefObject<HTMLElement|null>,open:boolean,initial:()=>Bounds,minWidth=300,minHeight=230){
 const [bounds,setBounds]=useState<Bounds|null>(null),latest=useRef(bounds);latest.current=bounds;
 const gesture=useRef<{id:number;x:number;y:number;start:Bounds;mode:'move'|'resize'}|null>(null);
 const fit=(value:Bounds):Bounds=>{const pad=12,w=Math.max(1,innerWidth-pad*2),h=Math.max(1,innerHeight-pad*2),width=Math.min(w,Math.max(Math.min(minWidth,w),value.width)),height=value.height===undefined?undefined:Math.min(h,Math.max(Math.min(minHeight,h),value.height));const actualHeight=height??Math.min(ref.current?.getBoundingClientRect().height??minHeight,h);return {...value,width,height,x:Math.max(pad,Math.min(value.x,innerWidth-pad-width)),y:Math.max(pad,Math.min(value.y,innerHeight-pad-actualHeight))};};
 useLayoutEffect(()=>{
  if(!open)return;setBounds(value=>fit(value??initial()));
  const update=()=>setBounds(value=>{if(!value)return value;const next=fit(value);return next.x===value.x&&next.y===value.y&&next.width===value.width&&next.height===value.height?value:next;});window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);
  let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);});if(ref.current)observer.observe(ref.current);
  return()=>{gesture.current=null;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);};
 },[open]);
 const start=(event:ReactPointerEvent,mode:'move'|'resize')=>{if(event.button!==0||mode==='move'&&(event.target as Element).closest('button,input,select,textarea,a,summary'))return;const rect=ref.current?.getBoundingClientRect();if(!rect)return;event.preventDefault();event.stopPropagation();const value={x:rect.x,y:rect.y,width:rect.width,...(mode==='resize'||latest.current?.height!==undefined?{height:rect.height}:{})};gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,start:value,mode};event.currentTarget.setPointerCapture(event.pointerId);};
 const move=(event:ReactPointerEvent)=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();const dx=event.clientX-g.x,dy=event.clientY-g.y;setBounds(fit(g.mode==='move'?{...g.start,x:g.start.x+dx,y:g.start.y+dy}:{...g.start,width:g.start.width+dx,height:(g.start.height??minHeight)+dy}));};
 const stop=(event:ReactPointerEvent)=>{if(gesture.current?.id!==event.pointerId)return;gesture.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
 const keys=(event:ReactKeyboardEvent)=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();const rect=ref.current?.getBoundingClientRect();if(!rect)return;const step=event.shiftKey?40:16;setBounds(fit({x:rect.x,y:rect.y,width:rect.width+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),height:rect.height+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)}));};
 const pointer={onPointerMove:move,onPointerUp:stop,onPointerCancel:stop};
 return {style:bounds?{position:'fixed',left:bounds.x,top:bounds.y,right:'auto',width:bounds.width,...(bounds.height!==undefined?{height:bounds.height}:{})} as CSSProperties:undefined,drag:{onPointerDown:(event:ReactPointerEvent)=>start(event,'move'),...pointer},resize:{onPointerDown:(event:ReactPointerEvent)=>start(event,'resize'),onKeyDown:keys,...pointer}};
}
