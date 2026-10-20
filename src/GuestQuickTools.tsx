import { useRef, useState, type RefObject } from 'react';
import { Keyboard } from 'lucide-react';
import GuestExchangePanel from './GuestExchangePanel.tsx';
import GuestTextInput from './GuestTextInput.tsx';

export default function GuestQuickTools({ id, connected, active = true, dropTarget, onPaste, onReadText, onKey, onReturn, terminal = false }: {
  id: string; connected: boolean; active?: boolean; dropTarget?: RefObject<HTMLDivElement | null>;
  onPaste: (text: string) => Promise<void>; onReadText?: () => Promise<string>;
  onKey: (key: 'backspace' | 'enter') => void; onReturn?: () => void; terminal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return <>
    <GuestExchangePanel key={`exchange-${id}`} id={id} connected={active && connected} active={active} dropTarget={dropTarget} onReturn={onReturn} onPasteText={terminal ? onPaste : undefined} onReadText={terminal ? onReadText : undefined}/>
    <button ref={toggle} type="button" className={`button guest-exchange-button ${open ? 'selected' : ''}`} title="中文与快捷输入" aria-label="中文与快捷输入" aria-expanded={open} disabled={!active || !connected} onClick={() => setOpen(value => !value)}><Keyboard size={17}/><span>中文输入</span></button>
    <GuestTextInput floating visible={active && open} anchorRef={toggle} key={`input-${id}`} id={id} connected={active && connected} terminal={terminal} onReadText={onReadText} onClose={() => {setOpen(false);onReturn?.();}} onPaste={onPaste} onKey={onKey}/>
  </>;
}
