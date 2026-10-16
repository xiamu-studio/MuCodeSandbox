import { z } from 'zod';

// Read-only diagnostic copy of the lab's current contract. No production schema changes.
const block = z.object({ type: z.string(), text: z.string().optional(), tool_use_id: z.string().optional(), is_error: z.boolean().optional(), content: z.unknown().optional() }).passthrough();
const contract = z.object({
  model: z.string().max(200), stream: z.boolean().default(false),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(block)]) })).min(1).max(100),
  tools: z.array(z.object({ name: z.string() }).passthrough()).max(100).default([]),
}).passthrough();
const kind = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const knownBlocks = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document', 'tool_reference']);

/** Call only for the fake-credential local relay. Returns structure, never prompt or headers. */
export function describeSyntheticCliRequest(input: { body: unknown; syntheticCredentialMatches: boolean; bodyBytes?: number }) {
  if (!input.syntheticCredentialMatches) return { inspected: false, reason: 'Not the explicitly synthetic request' };
  const body = object(input.body), parsed = contract.safeParse(input.body);
  const issues: { path: string; code: string; expected?: string }[] = [];
  const visit = (value: unknown) => {
    const issue = object(value);
    if (typeof issue.code === 'string' && issues.length < 25) issues.push({
      path: Array.isArray(issue.path) ? issue.path.map(part => typeof part === 'number' ? part : typeof part === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,50}$/.test(part) ? part : '?').join('.') : '',
      code: issue.code, ...(typeof issue.expected === 'string' ? { expected: issue.expected } : {}),
    });
    if (Array.isArray(issue.errors)) for (const alternatives of issue.errors) if (Array.isArray(alternatives)) for (const nested of alternatives) visit(nested);
  };
  if (!parsed.success) for (const issue of parsed.error.issues) visit(issue);
  return {
    inspected: true, validForCurrentLabContract: parsed.success,
    bodyBytes: input.bodyBytes ?? null, bodyType: kind(input.body),
    fields: Object.fromEntries(['model', 'stream', 'messages', 'tools', 'system', 'metadata', 'max_tokens', 'thinking', 'betas'].map(key => [key, kind(body[key])])),
    modelLength: typeof body.model === 'string' ? body.model.length : null,
    messageCount: Array.isArray(body.messages) ? body.messages.length : null,
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 100).map(message => {
      const item = object(message);
      return { role: item.role === 'user' || item.role === 'assistant' ? item.role : kind(item.role), contentType: kind(item.content),
        blocks: Array.isArray(item.content) ? item.content.slice(0, 100).map(content => { const b = object(content); return { type: typeof b.type === 'string' && knownBlocks.has(b.type) ? b.type : kind(b.type), textType: kind(b.text), textLength: typeof b.text === 'string' ? b.text.length : null, nestedContentType: kind(b.content) }; }) : null };
    }) : null,
    toolCount: Array.isArray(body.tools) ? body.tools.length : null,
    tools: Array.isArray(body.tools) ? body.tools.slice(0, 100).map(tool => { const t = object(tool); return { nameType: kind(t.name), nameLength: typeof t.name === 'string' ? t.name.length : null, typeType: kind(t.type) }; }) : null,
    issues,
  };
}
