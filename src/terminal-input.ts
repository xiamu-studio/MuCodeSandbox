// Shortcut tools paste text, never synthesize an Enter after it. A terminal
// without bracketed paste cannot safely receive multiple lines or a Tab.
export function safeTerminalPaste(text: string, bracketedPaste: boolean) {
  if (new TextEncoder().encode(text).length > 65536) throw new Error('文字超过64 KiB，请分段粘贴。');
  const value = text.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)) throw new Error('文字含终端控制字符，未粘贴；请先清理后重试。');
  if (!bracketedPaste && /[\n\t]/.test(value)) throw new Error('当前终端不支持安全的多行粘贴，请分行粘贴；原文已保留。');
  return value;
}

export function terminalInputChunks(text: string) {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 16000);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
    chunks.push(text.slice(offset, end)); offset = end;
  }
  return chunks;
}

export function quoteTerminalPath(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
