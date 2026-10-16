declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { password: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: { password: string }): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
  }
}
