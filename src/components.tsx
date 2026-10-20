import { useEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { X, LoaderCircle, AlertCircle, Check } from 'lucide-react';
import type { Environment } from '../shared/types.ts';
import {useFloatingTool} from './useFloatingTool.ts';

export const stateLabels: Record<Environment['state'], string> = { running: '运行中', stopped: '已停止', not_created: '未启动', creating: '创建中', starting: '启动中', stopping: '停止中', deleting: '删除中', error: '需处理' };
export function Status({ state }: { state: Environment['state'] }) { return <span className={`status status-${state}`}><span className="status-dot" />{stateLabels[state]}</span>; }
export function Button({ children, icon, loading, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; loading?: boolean }) {
  return <button type="button" {...props} disabled={props.disabled || loading} className={`button ${className}`}>{loading ? <LoaderCircle size={15} className="spin" /> : icon}{children}</button>;
}
export function IconButton({ title, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) { return <button type="button" {...props} className="icon-button" title={title} aria-label={title}>{children}</button>; }
export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'error' | 'success' }) { return <div className={`notice notice-${kind}`}>{kind === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}<span>{children}</span></div>; }
export function Modal({ title, subtitle, onClose, children, narrow, movable=false, onBackdropClose }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; narrow?: boolean; movable?:boolean; onBackdropClose?:()=>void }) {
  const element = useRef<HTMLElement>(null);
  const floating=useFloatingTool(element,movable,()=>{const width=Math.min(1100,innerWidth-24),height=Math.min(800,innerHeight-24);return{x:(innerWidth-width)/2,y:(innerHeight-height)/2,width,height};},360,300);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = element.current;
    dialog?.focus();
    const handler = (event: KeyboardEvent) => {
      // Only the visible top dialog owns keyboard navigation. IME Escape
      // cancels composition; it must not dismiss the user's draft.
      const visibleDialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(item => item.getClientRects().length);
      if (visibleDialogs.at(-1) !== dialog || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(dialog?.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],summary,[tabindex]') ?? [])]
        .filter(item => item.tabIndex >= 0 && !item.matches(':disabled') && !item.closest('[hidden],[inert]') && item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden');
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? items.at(-1)! : items[0]).focus(); }
      else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)!.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) (onBackdropClose??onClose)(); }}><section ref={element} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`modal ${narrow ? 'modal-narrow' : ''} ${movable?'modal-floating':''}`} style={movable?floating.style:undefined}><header className={`modal-header ${movable?'floating-tool-drag':''}`} {...(movable?floating.drag:{})}><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton title="关闭" onClick={onClose}><X size={20} /></IconButton></header>{children}{movable&&<button type="button" className="floating-tool-resize" aria-label="调整放大翻译窗口大小" title="拖动调整大小；方向键微调" {...floating.resize}>◢</button>}</section></div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>; }
export const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
