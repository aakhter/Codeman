#!/usr/bin/env node
/** Reproducible isolated branch canary: real Codex + HTTP + browser + plugin lifecycle; test Telegram adapter. */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import plugin from '../integrations/openclaw/index.mjs';
const root = mkdtempSync(join(tmpdir(), 'cod487-assistant-canary-'));
const home = join(root, 'home');
const data = join(root, 'data');
const workspace = join(root, 'workspace');
for (const dir of [home, data, workspace, join(home, '.codex')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) symlinkSync(auth, join(home, '.codex', 'auth.json'));
writeFileSync(
  join(home, '.codex', 'config.toml'),
  `check_for_update_on_startup = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
  { mode: 0o600 }
);
writeFileSync(
  join(workspace, 'AGENTS.md'),
  'This is an isolated smoke workspace. Reply to exact marker requests without tools.\n'
);
const socket = `cod487-canary-${process.pid}`;
const port = await new Promise((resolvePort) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolvePort(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const launcher = join(root, 'server.mjs');
writeFileSync(
  launcher,
  `const { startWebServer } = await import(${JSON.stringify(pathToFileURL(resolve('src/web/server.ts')).href)});\nconst server = await startWebServer(${port},false,true,'127.0.0.1');\nprocess.on('SIGTERM',async()=>{await server.stop();process.exit(0);});\n`,
  { mode: 0o600 }
);
const env = {
  ...process.env,
  HOME: home,
  CODEMAN_INSTANCE: socket,
  CODEMAN_TMUX_SOCKET: socket,
  CODEMAN_DATA_DIR: data,
  CODEX_HOME: join(home, '.codex'),
  CODEMAN_HOST: '127.0.0.1',
};
for (const name of ['CODEMAN_PASSWORD', 'CODEMAN_MULTIUSER', 'CODEMAN_USERNAME', 'CODEMAN_BASE_URL', 'VITEST'])
  delete env[name];
const server = spawn(process.execPath, ['--import', 'tsx', launcher], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (b) => {
  logs += b;
});
server.stderr.on('data', (b) => {
  logs += b;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await sleep(500);
  }
  throw new Error('Canary condition timed out');
};
async function api(path, method = 'GET', body) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.success === false)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value.data ?? value;
}
let sessionId;
let browser;
let service;
let assistant;
const receipts = [];
const errors = [];
const checks = [];
try {
  await until(async () => {
    try {
      return (await fetch(base + '/api/v1/assistants')).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await page.getByRole('button', { name: 'Open assistants', exact: true }).click();
  await page.getByRole('dialog', { name: 'Assistants', exact: true }).waitFor();
  await page.getByLabel('Assistant name', { exact: true }).fill('Canary Brain');
  await page.getByLabel('Assistant slug', { exact: true }).fill('canary-brain');
  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  assistant = await until(async () => (await api('/assistants')).assistants.find((a) => a.slug === 'canary-brain'));
  checks.push('desktop create');
  await page.screenshot({ path: join(root, 'desktop.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const created = await api('/sessions', 'POST', {
    mode: 'codex',
    workingDir: workspace,
    name: 'cod487-canary',
    codexConfig: { dangerouslyBypassApprovals: true },
  });
  sessionId = created.session.id;
  await api(`/sessions/${sessionId}/interactive`, 'POST');
  await sleep(5000);
  await api(`/sessions/${sessionId}/input`, 'POST', {
    input: 'Reply with exactly COD487_BOOTSTRAP_OK. Do not use tools.\r',
    useMux: true,
  });
  await until(
    async () => /^COD487_BOOTSTRAP_OK\.?$/.test((await api(`/sessions/${sessionId}/last-response`)).text?.trim() ?? ''),
    90000
  );
  await until(
    async () =>
      (await api(`/sessions/${sessionId}`)).session?.status === 'idle' ||
      (await api(`/sessions/${sessionId}`)).status === 'idle'
  );
  assistant = await api(`/assistants/${assistant.id}/binding`, 'POST', {
    sessionId,
    expectedRevision: assistant.revision,
    expectedGeneration: 0,
  });
  assistant = await api(`/assistants/${assistant.id}`, 'PATCH', {
    expectedRevision: assistant.revision,
    enabled: true,
  });
  for (const setting of ['auto-clear', 'auto-compact', 'checkpoint', 'auto-resume'])
    await api(`/sessions/${sessionId}/${setting}`, 'POST', { enabled: false });
  await sleep(1100);
  assistant = await api(`/assistants/${assistant.id}/handoff`, 'POST', {
    expectedRevision: assistant.revision,
    composerEmpty: true,
  });
  assert.equal(assistant.capabilities.requestExecution, true);
  checks.push('exact native binding and handoff');
  const denied = execFileSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      '--header',
      'Content-Type: application/json',
      '--data',
      JSON.stringify({ input: 'MUST_NOT_SEND\r' }),
      `${base}/api/v1/sessions/${sessionId}/input`,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(denied, '409');
  checks.push('curl HTTP input lock');
  const acknowledgement = await page.evaluate(
    ({ base, sessionId }) =>
      new Promise((resolveAck, rejectAck) => {
        const ws = new WebSocket(
          base.replace(/^http/, 'ws') + `/ws/sessions/${sessionId}/terminal?cid=cod487-canary-lock`
        );
        const timeout = setTimeout(() => {
          ws.close();
          rejectAck(new Error('WebSocket lock acknowledgement timed out'));
        }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({ t: 'i', d: 'MUST_NOT_SEND', seq: 1 }));
        ws.onmessage = (event) => {
          const value = JSON.parse(event.data);
          if (value.t === 'ia') {
            clearTimeout(timeout);
            ws.close();
            resolveAck(value.err);
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          ws.close();
          rejectAck(new Error('WebSocket lock probe failed'));
        };
      }),
    { base, sessionId }
  );
  assert.equal(acknowledgement, 'assistant_locked');
  checks.push('WebSocket input lock');
  const issued = await api(`/assistants/${assistant.id}/tokens`, 'POST', {
    name: 'canary',
    scopes: ['read', 'submit', 'cancel'],
  });
  process.env.COD487_CANARY_TOKEN = issued.token;
  const mediaRoot = join(root, 'telegram-inbound');
  mkdirSync(mediaRoot, { mode: 0o700 });
  const hiddenCode = randomBytes(6).toString('hex');
  const pdfCode = process.argv.includes('--pdf') ? randomBytes(6).toString('hex') : undefined;
  const pdfPath = join(mediaRoot, 'note.pdf');
  if (pdfCode) {
    execFileSync('python3', [
      '-c',
      'from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.drawString(72,720,"The secret code is "+sys.argv[2]); c.save()',
      pdfPath,
      pdfCode,
    ]);
  }
  const documentPath = join(mediaRoot, 'note.txt');
  const imagePath = join(mediaRoot, 'shape.png');
  writeFileSync(documentPath, `The secret code is ${hiddenCode}.`, { mode: 0o600 });
  const fixturePage = await browser.newPage({ viewport: { width: 240, height: 240 } });
  await fixturePage.setContent(
    '<html><body style="margin:0;background:white"><svg width="240" height="240"><polygon points="120,20 220,220 20,220" fill="blue"/></svg></body></html>'
  );
  await fixturePage.screenshot({ path: imagePath });
  await fixturePage.close();
  const acknowledgements = [];
  let ingress;
  plugin.register({
    pluginConfig: {
      baseUrl: base,
      assistantId: assistant.id,
      accountId: 'canary',
      allowFrom: ['123'],
      tokenEnv: 'COD487_CANARY_TOKEN',
      mediaRoot,
    },
    on: (name, handler) => {
      assert.ok(['inbound_claim', 'reply_dispatch'].includes(name));
      if (name === 'reply_dispatch') ingress = handler;
    },
    registerService: (value) => {
      service = value;
    },
    logger: { error: (message) => errors.push(message) },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (context) => {
              if (/^(On it|I already have)/.test(context.text)) {
                acknowledgements.push({ text: context.text, accountId: context.accountId, to: context.to });
                return { messageId: `ack-${acknowledgements.length}` };
              }
              receipts.push({ accountId: context.accountId, to: context.to, text: context.text });
              return { messageId: String(receipts.length) };
            },
          }),
        },
      },
    },
  });
  const serviceContext = { stateDir: join(root, 'gateway'), config: {} };
  await service.start(serviceContext);
  const event = {
    sendPolicy: 'allow',
    suppressUserDelivery: true,
    sourceReplyDeliveryMode: 'message_tool_only',
    ctx: {
      BodyForCommands: `Brain, Read the attached text file${pdfCode ? ' and PDF' : ''} and inspect the attached image. Reply only with the secret code in the text file, ${pdfCode ? 'the secret code in the PDF, ' : ''}then the shape and color in the image in lowercase, separated by spaces. Use tools.`,
      media: [
        { path: documentPath, contentType: 'text/plain', fileName: 'note.txt' },
        { path: imagePath, contentType: 'image/png', fileName: 'shape.png' },
        ...(pdfCode ? [{ path: pdfPath, contentType: 'application/pdf', fileName: 'note.pdf' }] : []),
      ],
      OriginatingChannel: 'telegram',
      ChatType: 'direct',
      CommandAuthorized: true,
      AccountId: 'canary',
      OriginatingTo: 'telegram:123',
      SenderId: '123',
      MessageSid: '456',
    },
  };
  const context = {
    dispatcher: {
      sendFinalReply: () => {
        throw new Error('Automatic delivery must stay suppressed');
      },
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };
  assert.equal((await ingress(event, context)).handled, true);
  // Temporary Telegram downloads can expire after durable acceptance.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(documentPath);
  unlinkSync(imagePath);
  if (pdfCode) unlinkSync(pdfPath);
  assert.equal((await ingress(event, context)).handled, true);
  assert.match(acknowledgements[0].text, /On it/);
  assert.match(acknowledgements[1].text, /already have/);
  assert.equal(acknowledgements[0].to, '123');
  assert.equal(acknowledgements[0].accountId, 'canary');
  checks.push('ordinary Telegram message_tool_only takeover and explicit acknowledgements');
  await until(async () => (await api(`/assistants/${assistant.id}/requests`)).requests.length === 1);
  await service.stop();
  await service.start(serviceContext);
  checks.push('duplicate update and managed gateway service restart');
  await until(() => receipts.length > 0, 120000);
  const requests = (await api(`/assistants/${assistant.id}/requests`)).requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'completed');
  assert.equal(requests[0].binding.conversationId, assistant.binding.conversationId);
  assert.equal(requests[0].result.text.trim(), `${hiddenCode}${pdfCode ? ` ${pdfCode}` : ''} triangle blue`);
  assert.match(requests[0].text, /\.codeman-telegram/);
  checks.push('real Codex reads durable text attachment and visually identifies image after temporary sources expire');
  assert.equal(receipts[0].text, requests[0].result.text);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].to, '123');
  if (pdfCode) checks.push('real Codex extracts hidden code from durable PDF attachment');
  checks.push('real CLI request completion and matching delivery');
  await page.getByRole('button', { name: 'Open assistants', exact: true }).click();
  await sleep(3500);
  assert.match(await page.locator('#assistantsList').innerText(), /completed/i);
  assert.equal(await page.locator('.assistant-nav-item[aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('.assistant-tiles').count(), 1);
  assert.ok(!(await page.locator('.assistant-card').innerText()).includes(assistant.binding.conversationId));
  await page.screenshot({ path: join(root, 'desktop-assistants.png') });
  const helper = await api('/assistants', 'POST', { name: 'Canary helper', slug: 'canary-helper' });
  await page.evaluate(() => app.refreshAssistants());
  await page.getByRole('button', { name: /Canary helper/ }).click();
  await page.locator(`.assistant-card[data-assistant-id="${helper.id}"]`).waitFor();
  assert.equal(await page.locator('.assistant-card .assistant-advanced-body').isVisible(), true);
  await page.getByRole('button', { name: /Canary Brain/ }).click();
  await page.locator(`.assistant-card[data-assistant-id="${assistant.id}"]`).waitFor();
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByLabel('Rename Canary Brain').fill('Unsaved draft');
  await sleep(4000);
  assert.equal(await page.getByLabel('Rename Canary Brain').inputValue(), 'Unsaved draft');
  await page.getByLabel('Rename Canary Brain').blur();
  await page.getByText('Advanced settings', { exact: true }).click();
  checks.push(
    'desktop overview, selected assistant navigation, advanced disclosure, hidden identifiers and focus-safe polling'
  );
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await until(async () => !(await api(`/assistants/${assistant.id}`)).enabled);
  checks.push('desktop result and Take control');
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(base, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await mobile.getByRole('button', { name: 'Open assistants', exact: true }).click();
  await mobile.getByRole('dialog', { name: 'Assistants', exact: true }).waitFor();
  assert.ok(await mobile.locator('#assistantsDialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  await mobile.screenshot({ path: join(root, 'mobile.png') });
  checks.push('mobile controls');
  assert.deepEqual(errors, []);
  writeFileSync(
    join(root, 'summary.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        sessionId,
        assistantId: assistant.id,
        conversationId: assistant.binding.conversationId,
        requestId: requests[0].id,
        telegram: 'test SDK adapter; no real bot credentials or poller',
        artifacts: root,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: true, checks, artifacts: root }));
} catch (error) {
  if (sessionId) {
    try {
      writeFileSync(
        join(root, 'terminal-failure.txt'),
        execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `codeman-${sessionId.slice(0, 8)}`], {
          encoding: 'utf8',
        }),
        { mode: 0o600 }
      );
    } catch {}
  }
  writeFileSync(
    join(root, 'summary.json'),
    JSON.stringify({ passed: false, error: error.message, errors, checks, artifacts: root }, null, 2)
  );
  console.error(JSON.stringify({ passed: false, error: error.message, artifacts: root }));
  process.exitCode = 1;
} finally {
  await service?.stop().catch(() => {});
  delete process.env.COD487_CANARY_TOKEN;
  if (assistant) await api(`/assistants/${assistant.id}/take-control`, 'POST', {}).catch(() => {});
  if (sessionId) await api(`/sessions/${sessionId}`, 'DELETE').catch(() => {});
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise((r) => {
    server.once('exit', r);
    setTimeout(r, 10000).unref();
  });
  // Diagnostics do not include tokens, native user transcripts, or provider credentials.
  if (process.exitCode) writeFileSync(join(root, 'server.log'), logs, { mode: 0o600 });
}
