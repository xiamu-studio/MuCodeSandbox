import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Volume2, VolumeX } from 'lucide-react';
import { request } from '../api.ts';
import { audioFormatMatches } from '../../shared/guest-audio.ts';
import { GuestAudioPlayer } from './guest-audio-player.ts';
import '../guest-audio.css';

export default function WindowsAudio({ id, connected }: { id: string; connected: boolean }) {
  const active = useRef<{ player: GuestAudioPlayer; socket?: WebSocket; generation: number; abort:AbortController; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const generation = useRef(0);
  const [state, setState] = useState<'off' | 'connecting' | 'playing'>('off');
  const [error, setError] = useState('');

  function stop(message = '') {
    generation.current++;
    const session = active.current; active.current = null;
    clearTimeout(session?.timer); session?.abort.abort();
    session?.socket?.close(); void session?.player.close();
    setState('off'); setError(message);
  }
  useEffect(() => { if (!connected) stop(); }, [connected]);
  useEffect(() => () => {
    generation.current++;
    const session = active.current; active.current = null;
    clearTimeout(session?.timer); session?.abort.abort();
    session?.socket?.close(); void session?.player.close();
  }, [id]);

  async function start() {
    if (active.current) { stop(); return; }
    setError(''); setState('connecting');
    // Resume directly in the click handler before asynchronous authorization.
    let player: GuestAudioPlayer;
    try { player = new GuestAudioPlayer(new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })); }
    catch (failure) { setState('off'); setError((failure as Error).message); return; }
    const session = { player, generation: ++generation.current, socket: undefined as WebSocket | undefined, abort:new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
    active.current = session;
    const current = () => active.current === session && generation.current === session.generation;
    session.timer = setTimeout(() => { if (current()) stop('音频连接超时，请重试'); }, 30_000);
    try {
      await player.context.resume();
      const { ticket } = await request<{ ticket: string }>(`/environments/${encodeURIComponent(id)}/guest-audio-ticket`, { method: 'POST', body: '{}',signal:session.abort.signal });
      if (!current()) return;
      const endpoint = new URL('/guest-audio', location.href);
      endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      endpoint.searchParams.set('ticket', ticket);
      const socket = new WebSocket(endpoint); session.socket = socket; socket.binaryType = 'arraybuffer';
      let formatted = false;
      socket.onmessage = event => {
        if (!current()) return;
        try {
          if (!formatted) {
            if (typeof event.data !== 'string' || !audioFormatMatches(JSON.parse(event.data))) throw new Error('音频格式无效');
            formatted = true; clearTimeout(session.timer); setState('playing'); return;
          }
          if (!(event.data instanceof ArrayBuffer)) throw new Error('音频数据无效');
          player.push(event.data);
        } catch (failure) { stop((failure as Error).message); }
      };
      socket.onerror = () => { if (current()) stop('音频连接失败，请重试'); };
      socket.onclose = () => { if (current()) stop('音频连接已结束'); };
      player.context.onstatechange = () => {
        if (current() && player.context.state !== 'running') stop('本机音频已暂停，请重新开启播放');
      };
    } catch (failure) { if (current()) stop((failure as Error).message); }
  }

  const label = state === 'off' ? '开启声音' : state === 'connecting' ? '正在连接声音' : '关闭声音';
  return <span className="guest-browser-audio-control">
    <button type="button" className={`icon-button ${state !== 'off' ? 'selected' : ''}`} title={error || `${label}：将 Linux 浏览器声音播放到本机`} aria-label={label} aria-pressed={state !== 'off'} disabled={!connected} onClick={() => void start()}>
      {state === 'connecting' ? <LoaderCircle size={16} className="spin" /> : state === 'playing' ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </button>
    {error && <span role="status" className="guest-browser-audio-error">{error}</span>}
  </span>;
}
