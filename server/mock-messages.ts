import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';

export const MOCK_CREDENTIAL = 'mu-lab-no-account';
export const MOCK_FILE = '/workspace/mu-claude-account-free/result.txt';
export const MOCK_CONTENT = 'MU_REAL_CLAUDE_TOOL_OK\n';
export const MOCK_BASH_FILE = '/workspace/mu-claude-account-free/bash-approved.txt';
const block = z.object({ type: z.string(), text: z.string().optional(), tool_use_id: z.string().optional(), is_error: z.boolean().optional(), content: z.unknown().optional() }).passthrough();
const input = z.object({
  model: z.string().max(200), stream: z.boolean().default(false),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(block)]) })).min(1).max(100),
  tools: z.array(z.object({ name: z.string() }).passthrough()).max(100).default([]),
}).passthrough();
export interface MockMessageReceipt {
  at: string; scenario: string; stream: boolean; toolResults: { id: string; error: boolean; content: unknown }[];
  emittedTool: string | null; completed: boolean; disconnected: boolean; promptTurns: number; historyMessages: number;
  historyToolResults: { id: string; error: boolean }[];
}

export function createMockMessages() {
  const receipts: MockMessageReceipt[] = [];
  const pending = new Set<Response>();
  const authorized = (req: Request) => req.headers['x-api-key'] === MOCK_CREDENTIAL || req.headers.authorization === `Bearer ${MOCK_CREDENTIAL}`;
  const countTokens = (req: Request, res: Response) => {
    if (!authorized(req)) { res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Synthetic lab credential required' } }); return; }
    res.setHeader('X-Mu-Mock', 'true'); res.json({ input_tokens: 1 });
  };
  const handle = async (req: Request, res: Response) => {
    if (!authorized(req)) { countTokens(req, res); return; }
    const body = input.parse(req.body);
    // Tool-result messages continue the current turn; a new user prompt starts a new fixture scenario.
    const prompts = body.messages.flatMap((m, index) => {
      if (m.role !== 'user') return [];
      const texts = typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').flatMap(b => b.text ? [b.text] : []);
      return texts.length ? [{ index, text: texts.join('\n') }] : [];
    });
    const prompt = prompts.at(-1);
    const scenario = ['TOOLS', 'WRITE', 'BASH', 'WAIT', 'CUT'].find(s => prompt?.text.includes(`MU_LAB_CLAUDE_${s}`)) ?? 'TEXT';
    const toolPrefix = prompts.length > 1 ? `toolu_mu_turn${prompts.length}_` : 'toolu_mu_';
    // The CLI can merge a refused tool result and the next prompt into one user message.
    const results = body.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_result').map(b => ({ id: b.tool_use_id ?? '', error: b.is_error ?? false, content: b.content })))
      .filter(result => result.id.startsWith(toolPrefix));
    let tool: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | undefined;
    const standardSteps = [
      { name: 'Write', input: { file_path: MOCK_FILE, content: MOCK_CONTENT } },
      { name: 'Read', input: { file_path: MOCK_FILE } },
      { name: 'Bash', input: { command: `id -un; cat ${MOCK_FILE}`, description: 'Read the synthetic guest fixture and show the guest user' } },
    ];
    const steps = scenario === 'WRITE' ? standardSteps.slice(0, 1) : scenario === 'BASH' ? [
      { name: 'Bash', input: { command: `printf '%s\\n' MU_TUI_BASH_APPROVED > ${MOCK_BASH_FILE}; id -un`, description: 'Write the synthetic permission fixture and show the guest user' } },
    ] : standardSteps;
    if (['TOOLS', 'WRITE', 'BASH'].includes(scenario)) {
      const next = steps.find((_step, index) => !results.some(r => r.id === `${toolPrefix}${index}`));
      if (next) {
        if (!body.tools.some(t => t.name === next.name)) throw new Error(`Required synthetic tool unavailable: ${next.name}`);
        tool = { type: 'tool_use', id: `${toolPrefix}${steps.indexOf(next)}`, ...next };
      }
    }
    if (scenario === 'CUT') tool = { type: 'tool_use', id: 'toolu_mu_cut', name: 'Write', input: { file_path: '/workspace/mu-claude-account-free/MUST_NOT_EXIST', content: 'INCOMPLETE' } };
    const receipt: MockMessageReceipt = { at: new Date().toISOString(), scenario, stream: body.stream, toolResults: results, emittedTool: tool?.name ?? null, completed: false, disconnected: false,
      promptTurns: prompts.length, historyMessages: body.messages.length,
      historyToolResults: body.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_result').map(b => ({ id: b.tool_use_id ?? '', error: b.is_error ?? false }))) };
    receipts.push(receipt); if (receipts.length > 200) receipts.shift();
    pending.add(res);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let ping: ReturnType<typeof setInterval> | undefined;
    res.on('close', () => { receipt.disconnected = !receipt.completed; pending.delete(res); for (const timer of timers) clearTimeout(timer); if (ping) clearInterval(ping); });
    res.setHeader('X-Mu-Mock', 'true'); res.setHeader('Cache-Control', 'no-store');
    const message = { id: `msg_mu_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
    const text = ['TOOLS', 'WRITE', 'BASH'].includes(scenario) ? 'MU_REAL_CLAUDE_TASK_COMPLETE' : 'MU_REAL_CLAUDE_TEXT_OK';
    if (!body.stream) {
      if (scenario === 'CUT') {
        const payload = JSON.stringify({ ...message, content: [tool], stop_reason: 'tool_use' });
        res.type('application/json'); res.setHeader('Content-Length', Buffer.byteLength(payload)); res.flushHeaders();
        res.write(payload.slice(0, payload.indexOf('INCOMPLETE') + 4));
        const timer = setTimeout(() => res.destroy(), 180); timers.add(timer); return;
      }
      receipt.completed = true;
      res.json({ ...message, content: tool ? [tool] : [{ type: 'text', text }], stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); return;
    }
    res.type('text/event-stream'); res.flushHeaders();
    const event = (type: string, value: Record<string, unknown>) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`); };
    event('message_start', { message });
    if (scenario === 'WAIT') {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'MU_REAL_CLAUDE_WAITING\n' } });
      ping = setInterval(() => event('ping', {}), 250); return;
    }
    if (tool) {
      event('content_block_start', { index: 0, content_block: { ...tool, input: {} } });
      const json = JSON.stringify(tool.input);
      const fragments = scenario === 'CUT' ? [json.slice(0, -2)] : [json.slice(0, 13), json.slice(13, 39), json.slice(39)];
      fragments.forEach((partial_json, index) => {
        const timer = setTimeout(() => event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json } }), (index + 1) * 40);
        timers.add(timer);
      });
      if (scenario === 'CUT') { const timer = setTimeout(() => res.destroy(), 180); timers.add(timer); return; }
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 12) } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(12) } });
    }
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {}); receipt.completed = true; res.end();
    }, tool ? 180 : 40);
    timers.add(timer);
  };
  const close = () => { for (const response of pending) response.destroy(); pending.clear(); };
  return { handle, countTokens, receipts, close };
}
