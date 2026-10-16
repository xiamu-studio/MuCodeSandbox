import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAcceptanceLab } from '../server/acceptance-lab.ts';
import { MOCK_CREDENTIAL, MOCK_FILE } from '../server/mock-messages.ts';

test('Messages lab rejects real credentials and invalid input and does not expose a forwarding route', async () => {
  const lab = await createAcceptanceLab();
  try {
    const url = lab.info().url;
    const unauthorized = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'not-a-lab-key' }, body: '{}' });
    assert.equal(unauthorized.status, 401); assert.equal(lab.messages.length, 0);
    const invalid = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL }, body: '{}' });
    assert.equal(invalid.status, 400); assert.equal(lab.messages.length, 0);
    const blockedHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/messages`, { method: 'POST', headers: { Host: 'outside.invalid' } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end();
    });
    assert.equal(blockedHost, 403);
  } finally { await lab.close(); }
});

test('Messages lab streams fragmented tool input and records actual supplied tool results', async () => {
  const lab = await createAcceptanceLab();
  const request = (body: unknown) => fetch(`${lab.info().url}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MOCK_CREDENTIAL}` }, body: JSON.stringify(body) });
  try {
    const messages: any[] = [{ role: 'user', content: 'MU_LAB_CLAUDE_TOOLS' }];
    const tools = ['Write', 'Read', 'Bash'].map(name => ({ name }));
    for (let index = 0; index < 3; index++) {
      const response = await request({ model: 'synthetic-only', stream: true, messages, tools });
      assert.equal(response.headers.get('x-mu-mock'), 'true');
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const start = events.find(e => e.type === 'content_block_start').content_block;
      assert.equal(start.name, tools[index].name);
      const parts = events.filter(e => e.type === 'content_block_delta').map(e => e.delta.partial_json);
      assert.ok(parts.length > 1); const input = JSON.parse(parts.join(''));
      if (index < 2) assert.equal(input.file_path, MOCK_FILE);
      assert.equal(events.at(-1).type, 'message_stop');
      messages.push({ role: 'assistant', content: [{ ...start, input }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: start.id, content: `Synthetic result ${index}`, is_error: index === 1 }] });
    }
    const response = await request({ model: 'synthetic-only', messages, tools });
    assert.equal((await response.json()).stop_reason, 'end_turn');
    assert.equal(lab.messages.at(-1)!.toolResults[1].error, true);
    assert.equal(lab.messages.at(-1)!.toolResults[2].content, 'Synthetic result 2');
  } finally { await lab.close(); }
});

test('unfinished Messages streams can be aborted and lab shutdown closes active responses', async () => {
  const lab = await createAcceptanceLab();
  try {
    const controller = new AbortController();
    const response = await fetch(`${lab.info().url}/v1/messages`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL },
      body: JSON.stringify({ model: 'synthetic-only', stream: true, messages: [{ role: 'user', content: 'MU_LAB_CLAUDE_WAIT' }] }) });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /MU_REAL_CLAUDE_WAITING/);
    controller.abort(); await assert.rejects(reader.read());
    await lab.close(); assert.equal(lab.messages[0].completed, false);
  } finally { await lab.close(); }
});

test('Messages lab routes the latest prompt and scopes tool results to its turn', async () => {
  const lab = await createAcceptanceLab();
  const messages: any[] = [{ role: 'user', content: 'MU_LAB_CLAUDE_TOOLS' }];
  const request = () => fetch(`${lab.info().url}/v1/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL },
    body: JSON.stringify({ model: 'synthetic-only', messages, tools: ['Write', 'Read', 'Bash'].map(name => ({ name })) }) });
  try {
    let response = await (await request()).json();
    assert.equal(response.content[0].id, 'toolu_mu_0');
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mu_0', content: 'User denied this write', is_error: true }] });
    response = await (await request()).json();
    assert.equal(response.content[0].name, 'Read');
    assert.equal(lab.messages.at(-1)!.toolResults[0].error, true);
    messages.push({ role: 'user', content: [{ type: 'text', text: 'MU_LAB_CLAUDE_TEXT' }] });
    response = await (await request()).json();
    assert.equal(response.content[0].text, 'MU_REAL_CLAUDE_TEXT_OK');
    assert.deepEqual(lab.messages.at(-1)!.toolResults, []);
    assert.deepEqual(lab.messages.at(-1)!.historyToolResults, [{ id: 'toolu_mu_0', error: true }]);
    messages.push({ role: 'user', content: 'MU_LAB_CLAUDE_TOOLS' });
    response = await (await request()).json();
    assert.equal(response.content[0].name, 'Write');
    assert.equal(response.content[0].id, 'toolu_mu_turn3_0');
    assert.equal(lab.messages.at(-1)!.promptTurns, 3);
    messages.push({ role: 'user', content: 'MU_LAB_CLAUDE_WAIT' });
    await (await request()).text();
    assert.equal(lab.messages.at(-1)!.scenario, 'WAIT');
  } finally { await lab.close(); }
});

test('Single-tool permission fixtures record refusal and expose a real Bash write', async () => {
  const lab = await createAcceptanceLab();
  const request = (messages: unknown[]) => fetch(`${lab.info().url}/v1/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL },
    body: JSON.stringify({ model: 'synthetic-only', messages, tools: [{ name: 'Write' }, { name: 'Bash' }] }) });
  try {
    const messages: any[] = [{ role: 'user', content: 'MU_LAB_CLAUDE_WRITE' }];
    const first = await (await request(messages)).json();
    assert.equal(first.content[0].name, 'Write');
    messages.push({ role: 'assistant', content: first.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, is_error: true, content: 'User denied permission' }] });
    assert.equal((await (await request(messages)).json()).stop_reason, 'end_turn');
    assert.equal(lab.messages.at(-1)!.toolResults[0].error, true);
    messages.push({ role: 'user', content: 'MU_LAB_CLAUDE_BASH' });
    const bash = await (await request(messages)).json();
    assert.equal(bash.content[0].name, 'Bash');
    assert.match(bash.content[0].input.command, /> \/workspace\/mu-claude-account-free\/bash-approved\.txt/);
    assert.deepEqual(lab.messages.at(-1)!.toolResults, []);
  } finally { await lab.close(); }
});

test('A rejected tool merged with the next prompt cannot contaminate that turn', async () => {
  const lab = await createAcceptanceLab();
  const messages: any[] = [
    { role: 'user', content: 'MU_LAB_CLAUDE_WRITE' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mu_0', name: 'Write', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_mu_0', is_error: true, content: 'User refused' },
      { type: 'text', text: 'MU_LAB_CLAUDE_TOOLS' },
    ] },
  ];
  try {
    for (const name of ['Write', 'Read', 'Bash']) {
      const response = await fetch(`${lab.info().url}/v1/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL },
        body: JSON.stringify({ model: 'synthetic-only', messages, tools: ['Write', 'Read', 'Bash'].map(name => ({ name })) }) });
      const value = await response.json(); assert.equal(value.content[0].name, name);
      assert.ok(lab.messages.at(-1)!.toolResults.every(t => !t.error));
      assert.deepEqual(lab.messages.at(-1)!.historyToolResults[0], { id: 'toolu_mu_0', error: true });
      messages.push({ role: 'assistant', content: value.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: value.content[0].id, content: 'Actual next-turn result' }] });
    }
  } finally { await lab.close(); }
});

test('Truncated tool faults remain incomplete when a client retries without streaming', async () => {
  const lab = await createAcceptanceLab();
  try {
    for (const stream of [true, false]) {
      const response = await fetch(`${lab.info().url}/v1/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_CREDENTIAL },
        body: JSON.stringify({ model: 'synthetic-only', stream, messages: [{ role: 'user', content: 'MU_LAB_CLAUDE_CUT' }] }) });
      assert.equal(response.status, 200);
      await assert.rejects(response.text());
      assert.equal(lab.messages.at(-1)!.completed, false);
      const deadline = Date.now() + 2000;
      while (!lab.messages.at(-1)!.disconnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(lab.messages.at(-1)!.disconnected, true);
      assert.equal(lab.messages.at(-1)!.stream, stream);
    }
  } finally { await lab.close(); }
});
