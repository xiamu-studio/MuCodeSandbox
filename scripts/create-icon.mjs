import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalSquare } from 'lucide-react';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'assets'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const icon = renderToStaticMarkup(React.createElement(TerminalSquare, { size: 640, strokeWidth: 1.45, color: '#f5fff8' }));
  await page.setContent(`<html><body style="margin:0;background:transparent"><div id="icon" style="width:1024px;height:1024px;background:#2c7459;border-radius:180px;display:grid;place-items:center">${icon}</div></body></html>`);
  await page.screenshot({ path: path.join(root, 'assets/icon.png'), omitBackground: true });
} finally { await browser.close(); }
