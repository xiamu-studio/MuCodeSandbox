import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Environment, BrowserInspection, BrowserVersionStatus } from '../shared/types.ts';
import { AppError } from './errors.ts';
import type { RunOptions } from './process.ts';
import { localBrowserStartUrl } from './browser-startpage.ts';

export interface BrowserHost {
  available(): Promise<boolean>;
  native: boolean;
  running(id: string): boolean;
  open(environment: Environment, options?: RunOptions, showWindow?:boolean): Promise<void>;
  openGuest?(environment:Environment,url:string):Promise<void>;
  closeGuest?(id:string):Promise<void>;
  focus?(environment:Environment,target:'browser'|'grok-bot'|'claude-desktop'):Promise<boolean>;
  openLink?(environment:Environment,url:string,options?:RunOptions):Promise<void>;
  showGuestApplication?(environment:Environment,target:'browser'|'desktop',application?:string):Promise<void>;
  ensureDisplay?(environment: Environment, options?: RunOptions): Promise<void>;
  closeApplication?(id: string): Promise<void>;
  close(id: string): Promise<void>;
  clear(id: string): Promise<void>;
  dispose(): Promise<void>;
  inspect?(id: string): Promise<BrowserInspection>;
  assertProtection?(id: string): Promise<void>;
  versionStatus?(environment: Environment): Promise<BrowserVersionStatus>;
  update?(environment: Environment, options?: RunOptions): Promise<void>;
  recover?(environment: Environment, options?: RunOptions): Promise<void>;
  reset?(environment: Environment, options?: RunOptions): Promise<void>;
}

export class ChromeHost implements BrowserHost {
  native = false;
  dataDir: string;
  processes = new Map<string, ChildProcess>();
  executable: string | null = null;
  constructor(dataDir: string) { this.dataDir = dataDir; }
  async available() {
    for (const file of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
      try { await access(file); this.executable = file; return true; } catch { /* Probe known browser locations. */ }
    }
    return false;
  }
  running(id: string) { return this.processes.has(id); }
  async open(e: Environment) {
    if (this.running(e.id)) return;
    if (!await this.available()) throw new AppError('没有找到 Chrome；桌面版包含 Chromium 浏览器', 409);
    if (e.identity.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone || e.identity.locale !== 'en-US') throw new AppError('独立时区和语言请在桌面版中打开浏览器', 409);
    if (e.network.mode !== 'direct' && (e.network.username || e.network.password)) throw new AppError('带账号密码的代理请在桌面版中打开浏览器', 409);
    const profile = path.join(this.dataDir, 'browsers', e.id);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', '--disable-background-mode'];
    if (e.network.mode === 'direct') args.push('--no-proxy-server');
    else args.push(`--proxy-server=${e.network.mode}://${e.network.host}:${e.network.port}`, `--proxy-bypass-list=${e.network.noProxy.replace(/,/g, ';')}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    args.push(localBrowserStartUrl(e.browserUrl));
    const child = spawn(this.executable!, args, { stdio: 'ignore', detached: false });
    this.processes.set(e.id, child);
    child.once('close', () => { if (this.processes.get(e.id) === child) this.processes.delete(e.id); });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  async close(id: string) {
    const child = this.processes.get(id);
    if (!child) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => { child.once('close', () => resolve()); setTimeout(resolve, 3000).unref(); });
    if (child.exitCode === null) child.kill('SIGKILL');
    this.processes.delete(id);
  }
  async dispose() { for (const id of this.processes.keys()) await this.close(id); }
  async clear(id: string) { await this.close(id); }
}
