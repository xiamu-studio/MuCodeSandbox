import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { MOCK_CREDENTIAL, MOCK_CONTENT, MOCK_FILE, MOCK_BASH_FILE, type MockMessageReceipt } from '../server/mock-messages.ts';
import { shellQuote } from '../server/network-guard.ts';

export async function verifyClaudeTui(options: {
  page: Page; artifacts: string; messages: MockMessageReceipt[]; output: () => string;
  guest: (args: string[]) => Promise<string>; admin: (args: string[]) => Promise<string>;
  closeTerminal: () => Promise<Record<string, unknown>>;
  observeHostPty?: () => Promise<unknown>;
  inputText?: (value: string) => Promise<void>;
  report: Record<string, any>;
}) {
  const { page, artifacts, messages, guest, admin, report } = options;
  const configDir = '/home/dev/.mu-claude-tui-account-free';
  const screen = () => page.locator('.xterm-rows').innerText();
  async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) { assert.ok(Date.now() < deadline, 'TUI observation timed out'); await delay(100); }
  }
  async function snapshot(name: string) {
    await writeFile(path.join(artifacts, `${name}.txt`), await screen(), { mode: 0o600 });
    await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
  }
  async function keys(value: string) { await page.keyboard.press(value); await delay(300); }
  async function type(value: string) {
    const input = page.locator('.xterm-helper-textarea'); await input.focus();
    if (options.inputText) await options.inputText(value);
    else await page.keyboard.insertText(value);
    await keys('Enter');
  }
  async function cliPids() {
    return JSON.parse(await admin(['sudo', 'python3', '-c', `import pathlib,json
rows=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  env=(p/'environ').read_bytes().split(bytes([0]))
  if b'CLAUDE_CONFIG_DIR=${configDir}' not in env: continue
  exe=(p/'exe').readlink().as_posix()
  if 'claude' not in exe: continue
  rows.append({'pid':int(p.name),'exe':exe,'uid':(p/'status').read_text().split('Uid:')[1].split()[0]})
 except (FileNotFoundError,ProcessLookupError,PermissionError): pass
print(json.dumps(rows))`]));
  }
  const cli = ['env', 'ANTHROPIC_BASE_URL=http://203.0.113.80', `ANTHROPIC_AUTH_TOKEN=${MOCK_CREDENTIAL}`,
    `CLAUDE_CONFIG_DIR=${configDir}`, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'IS_DEMO=1', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1',
    'DISABLE_ERROR_REPORTING=1', 'API_TIMEOUT_MS=10000', 'claude', '--model', 'claude-sonnet-4-5-20250929',
    '--tools', 'Read,Write,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome'];
  async function startCli(resume = false) {
    await type(`stty -echo; ${[...cli, ...(resume ? ['--continue'] : [])].map(shellQuote).join(' ')}; printf '\\nMU_TUI_PROCESS_EXIT=%s\\n' "$?"; stty echo`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = await screen();
      if (/Choose the text style|Choose.*theme|Select.*theme/i.test(current)) { await snapshot('onboarding-theme'); report.onboarding.push('Theme selected through actual TUI'); await keys('Enter'); }
      else if (/Do you want to use this API key/i.test(current)) { await snapshot('onboarding-api-key'); report.onboarding.push('Synthetic API key confirmed through actual TUI'); await keys('ArrowUp'); await keys('Enter'); }
      else if (/trust.*(?:folder|files)|Is this a project you created/i.test(current) && /Yes|trust/i.test(current)) { await snapshot('onboarding-trust'); report.onboarding.push('Disposable workspace trust confirmed through actual TUI'); await keys('Enter'); }
      else if (/Security notes|Press Enter to continue/i.test(current)) { await snapshot('onboarding-notice'); report.onboarding.push('CLI notice acknowledged through actual TUI'); await keys('Enter'); }
      else if (/❯/.test(current) && /manual mode on/.test(current) && !/Choose|Do you want|Select.*login/i.test(current) && (await cliPids()).length === 1) {
        await delay(800); await snapshot(resume ? 'resumed-ready' : 'initial-ready'); return;
      } else await delay(200);
    }
    await snapshot('onboarding-unhandled'); throw new Error('Actual CLI onboarding did not reach an interactive prompt');
  }
  await until(async () => (await screen()).includes('/workspace'));
  await startCli();
  report.interactiveProcesses = await cliPids(); assert.equal(report.interactiveProcesses.length, 1); assert.notEqual(report.interactiveProcesses[0].uid, '0');
  if (options.observeHostPty) report.nativeHostPty = await options.observeHostPty();
  await type('MU_LAB_CLAUDE_WRITE');
  await until(async () => (await screen()).includes('Do you want to create result.txt?'));
  await snapshot('write-denial-prompt'); await assert.rejects(guest(['test', '-e', MOCK_FILE]));
  await keys('ArrowDown'); await keys('ArrowDown'); await keys('Enter');
  await until(async () => (await screen()).includes('User rejected write'));
  await assert.rejects(guest(['test', '-e', MOCK_FILE])); await snapshot('write-denied');
  report.denial = { selectedNoThroughTui: true, fileAbsentAfterRefusal: true };
  await type('MU_LAB_CLAUDE_TOOLS');
  await until(() => messages.some(r => r.scenario === 'TOOLS' && r.emittedTool === 'Write'));
  await until(async () => /Do you want|Allow|create.*result\.txt/i.test(await screen()));
  await snapshot('write-permission'); await assert.rejects(guest(['test', '-e', MOCK_FILE]));
  await keys('Enter');
  await until(async () => { try { return await guest(['cat', MOCK_FILE]) === MOCK_CONTENT; } catch { return false; } });
  await until(() => messages.some(r => r.scenario === 'TOOLS' && r.emittedTool === null && r.toolResults.length === 3));
  const final = messages.find(r => r.scenario === 'TOOLS' && r.emittedTool === null && r.toolResults.length === 3)!;
  assert.ok(final.historyToolResults.some(r => r.id === 'toolu_mu_0' && r.error), 'Next request must retain the user refusal');
  report.denial.actualErrorToolReceiptInNextTurn = true;
  assert.ok(final.toolResults.every(r => !r.error)); assert.match(JSON.stringify(final.toolResults), /dev/);
  await until(async () => (await screen()).includes('MU_REAL_CLAUDE_TASK_COMPLETE')); await snapshot('tools-completed');
  report.permissions = { writeAbsentBeforeApproval: true, actualWriteReadBash: true, readonlyBashAllowedByNormalCliPolicy: true, noBlanketToolAllow: true };
  await type('MU_LAB_CLAUDE_BASH');
  await until(async () => /Do you want|Allow/i.test(await screen()) && (await screen()).includes('bash-approved.txt'));
  await snapshot('bash-permission'); await assert.rejects(guest(['test', '-e', MOCK_BASH_FILE])); await keys('Enter');
  await until(() => messages.some(r => r.scenario === 'BASH' && r.toolResults.length === 1 && !r.toolResults[0].error));
  assert.equal((await guest(['cat', MOCK_BASH_FILE])).trim(), 'MU_TUI_BASH_APPROVED');
  report.permissions.bashWriteAbsentBeforeApproval = true; report.permissions.bashWriteApprovedThroughTui = true;
  const waitingAt = messages.length;
  await type('MU_LAB_CLAUDE_WAIT');
  await until(() => messages.slice(waitingAt).some(r => r.scenario === 'WAIT'));
  await until(async () => (await screen()).includes('MU_REAL_CLAUDE_WAITING')); await snapshot('waiting');
  await keys('Escape');
  await until(() => messages.slice(waitingAt).filter(r => r.scenario === 'WAIT').every(r => r.disconnected));
  report.processesAfterCancel = await cliPids(); assert.deepEqual(report.processesAfterCancel, report.interactiveProcesses);
  const recoveredAt = messages.length; await type('MU_LAB_CLAUDE_TEXT');
  await until(() => messages.slice(recoveredAt).some(r => r.scenario === 'TEXT' && r.completed));
  await until(async () => (await screen()).includes('MU_REAL_CLAUDE_TEXT_OK')); await snapshot('same-process-recovered');
  report.cancellation = { key: 'Escape', streamClosed: true, sameCliProcessAlive: true, nextInteractiveTurnSucceeded: true };
  const priorTurns = messages.at(-1)!.promptTurns;
  await type('/exit'); await until(() => options.output().includes('MU_TUI_PROCESS_EXIT=0')); assert.deepEqual(await cliPids(), []);
  await startCli(true); report.reopenedProcesses = await cliPids(); assert.equal(report.reopenedProcesses.length, 1);
  assert.notEqual(report.reopenedProcesses[0].pid, report.interactiveProcesses[0].pid);
  await snapshot('continued-conversation');
  const resumeAt = messages.length; await type('MU_LAB_CLAUDE_TEXT');
  await until(() => messages.slice(resumeAt).some(r => r.scenario === 'TEXT' && r.completed));
  const resumed = messages.slice(resumeAt).find(r => r.scenario === 'TEXT' && r.completed)!;
  assert.ok(resumed.promptTurns > priorTurns, 'Continuation must carry prior user turns in the actual API request');
  await snapshot('continued-turn-completed'); report.reopen = { continueFlag: true, previousTurnsInActualRequest: priorTurns,
    resumedPromptTurns: resumed.promptTurns, nextInteractiveTurnSucceeded: true };
  const disconnectAt = messages.length;
  await type('MU_LAB_CLAUDE_WAIT');
  await until(() => messages.slice(disconnectAt).some(r => r.scenario === 'WAIT'));
  await until(async () => (await screen()).includes('esc to interrupt')); await snapshot('before-terminal-disconnect');
  const closed = await options.closeTerminal();
  await until(async () => (await cliPids()).length === 0);
  report.processesAfterDisconnect = await cliPids();
  await until(() => messages.slice(disconnectAt).filter(r => r.scenario === 'WAIT').every(r => r.disconnected));
  report.terminalDisconnect = { ...closed, guestCliExited: true, streamClosed: true };
}
