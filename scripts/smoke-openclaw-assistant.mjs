#!/usr/bin/env node
/** Reproducible isolated branch canary: real Codex + HTTP + browser + plugin lifecycle; test channel adapter. */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import plugin from '../integrations/openclaw/index.mjs';
const mode = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) || 'codex';
assert.ok(['codex', 'claude', 'opencode'].includes(mode));
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
if (mode === 'claude') {
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  for (const [source, target] of [
    [join(homedir(), '.claude', '.credentials.json'), join(home, '.claude', '.credentials.json')],
    [join(homedir(), '.claude.json'), join(home, '.claude.json')],
    [join(homedir(), '.claude.json'), join(home, '.claude', '.claude.json')],
  ]) {
    if (existsSync(source)) {
      if (source.endsWith('/.credentials.json')) symlinkSync(source, target);
      else {
        copyFileSync(source, target);
        chmodSync(target, 0o600);
      }
    }
  }
  writeFileSync(
    join(data, 'settings.json'),
    JSON.stringify({ claudeMode: 'allowedTools', allowedTools: 'Read', agentSkillEnabled: false }),
    { mode: 0o600 }
  );
}
if (mode === 'opencode') {
  for (const [source, target] of [
    [join(homedir(), '.local/share/opencode/auth.json'), join(home, '.local/share/opencode/auth.json')],
    [join(homedir(), '.config/opencode/opencode.json'), join(home, '.config/opencode/opencode.json')],
  ]) {
    if (existsSync(source)) {
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
  }
}
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
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
const documents = [];
let resultDeliveryAttempts = 0;
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
  let recoveryGroupId;
  if (process.argv.includes('--recovery-failure')) {
    assert.equal(mode, 'codex');
    const wrapper = join(root, 'codex-recovery-wrapper.sh');
    const marker = join(root, 'first-resume-failed');
    const bin = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = resume ] && [ ! -f '${marker}' ]; then touch '${marker}'; echo 'fixture transient startup failure'; exit 1; fi\nexec '${bin}' --dangerously-bypass-approvals-and-sandbox "$@"\n`,
      { mode: 0o700 }
    );
    const profile = await api('/codex-command-profiles', 'POST', {
      name: 'Recovery canary',
      command: `exec ${wrapper}`,
      resumeCommandTemplate: `exec ${wrapper} resume {{resumeId}}`,
    });
    await api('/cases/link', 'POST', {
      name: 'canary-recovery',
      path: workspace,
      codexCommandSelection: { kind: 'profile', profileId: profile.id },
    });
  }
  const created = await api('/sessions', 'POST', {
    mode,
    caseName: process.argv.includes('--recovery-failure') ? 'canary-recovery' : undefined,
    workingDir: workspace,
    name: 'cod487-canary',
    codexConfig: mode === 'codex' ? { dangerouslyBypassApprovals: true } : undefined,
    openCodeConfig: mode === 'opencode' ? { autoAllowTools: true } : undefined,
    model: mode === 'claude' ? 'haiku' : undefined,
  });
  sessionId = created.session.id;
  if (process.argv.includes('--recovery')) {
    recoveryGroupId = 'canary-group';
    const { layout } = await api('/tab-layout');
    await api('/tab-layout', 'PUT', {
      baseVersion: layout.version,
      operations: [
        { type: 'createGroup', id: recoveryGroupId, name: 'Recovery group' },
        { type: 'moveRef', ref: { kind: 'session', id: sessionId }, groupId: recoveryGroupId, index: 0 },
      ],
    });
  }

  await api(`/sessions/${sessionId}/interactive`, 'POST');
  await until(async () => {
    const frame = await api(`/sessions/${sessionId}/terminal?frame=1`);
    const plain = frame.terminalBuffer.replace(/\x1b\[[0-9]+;[0-9]+H/g, '\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    return mode === 'opencode'
      ? plain.includes('Ask anything')
      : mode === 'claude'
        ? /❯\s*(?:Try[^\n]*)?\s*$/.test(plain.split('\n').findLast((l) => l.trimStart().startsWith('❯')) || '')
        : plain.includes('›');
  }, 90000);
  await sleep(1000);
  await api(`/sessions/${sessionId}/input`, 'POST', {
    input: 'Reply with exactly COD487_BOOTSTRAP_OK. Do not use tools.\r',
    useMux: true,
  });
  await until(async () => {
    try {
      assistant = await api(`/assistants/${assistant.id}/binding`, 'POST', {
        sessionId,
        expectedRevision: assistant.revision,
        expectedGeneration: 0,
      });
      return assistant;
    } catch {
      return undefined;
    }
  }, 90000);
  assistant = await api(`/assistants/${assistant.id}`, 'PATCH', {
    expectedRevision: assistant.revision,
    enabled: true,
  });
  for (const setting of ['auto-clear', 'auto-compact', 'checkpoint', 'auto-resume'])
    await api(`/sessions/${sessionId}/${setting}`, 'POST', { enabled: false });
  await sleep(1100);
  assistant = await until(async () => {
    try {
      return await api(`/assistants/${assistant.id}/handoff`, 'POST', {
        expectedRevision: assistant.revision,
        composerEmpty: true,
      });
    } catch {
      return undefined;
    }
  }, 90000);
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
  const whatsapp = process.argv.includes('--whatsapp');
  const channel = whatsapp ? 'whatsapp' : 'telegram';
  const sender = whatsapp ? '+15551234567' : '123';
  const mediaRoot = join(root, `${channel}-inbound`);
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
      ...(whatsapp ? { whatsapp: { accountId: 'canary', allowFrom: [sender], mediaRoot } } : {}),
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
          loadAdapter: async (adapterChannel) => {
            assert.equal(adapterChannel, channel);
            return {
              sendMedia: async (context) => {
                documents.push({
                  path: context.mediaUrl,
                  data: readFileSync(context.mediaUrl, 'utf8'),
                  to: context.to,
                });
                assert.equal(context.forceDocument, true);
                return { messageId: `CSV${documents.length}` };
              },
              sendText: async (context) => {
                if (/^(On it|I already have)/.test(context.text)) {
                  acknowledgements.push({ text: context.text, accountId: context.accountId, to: context.to });
                  return { messageId: String(10000 + acknowledgements.length) };
                }
                if (++resultDeliveryAttempts === 1 && process.argv.includes('--delivery-retry'))
                  throw new Error(whatsapp ? 'Connection Closed' : "Network request for 'sendMessage' failed!");
                receipts.push({ accountId: context.accountId, to: context.to, text: context.text });
                return { messageId: String(receipts.length) };
              },
            };
          },
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
      OriginatingChannel: channel,
      ChatType: 'direct',
      CommandAuthorized: !whatsapp,
      AccountId: 'canary',
      OriginatingTo: `${channel}:${sender}`,
      SenderId: sender,
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
  // Temporary channel downloads can expire after durable acceptance.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(documentPath);
  unlinkSync(imagePath);
  if (pdfCode) unlinkSync(pdfPath);
  assert.equal((await ingress(event, context)).handled, true);
  assert.match(acknowledgements[0].text, /On it/);
  assert.match(acknowledgements[1].text, /already have/);
  assert.equal(acknowledgements[0].to, sender);
  assert.equal(acknowledgements[0].accountId, 'canary');
  checks.push(`ordinary ${channel} message_tool_only takeover and explicit acknowledgements`);
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
  checks.push(
    `real ${mode} reads durable text attachment and visually identifies image after temporary sources expire`
  );
  assert.equal(receipts[0].text, requests[0].result.text);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].to, sender);
  if (pdfCode) checks.push(`real ${mode} extracts hidden code from durable PDF attachment`);
  checks.push('real CLI request completion and matching delivery');
  if (process.argv.includes('--delivery-retry')) {
    assert.equal(resultDeliveryAttempts, 2);
    checks.push(
      `transient ${channel} send failure automatically retries the saved answer without rerunning native request`
    );
  }

  if (process.argv.includes('--reply')) {
    await service.stop();
    await service.start(serviceContext);
    const replyEvent = {
      ...event,
      suppressUserDelivery: false,
      sourceReplyDeliveryMode: 'direct',
      ctx: {
        ...event.ctx,
        media: [],
        MessageSid: '457',
        ReplyToId: '1',
        ReplyToBody: 'quoted context must not become the prompt',
        BodyForCommands:
          'Reply with the secret code from the attached text file you just read, followed by FOLLOWUP_OK, and nothing else. Do not use tools.',
      },
    };
    assert.equal((await ingress(replyEvent, context)).handled, true);
    assert.equal((await ingress(replyEvent, context)).handled, true);
    await until(() => receipts.length === 2, 120000);
    assert.equal(receipts[1].text.trim(), `${hiddenCode} FOLLOWUP_OK`);
    const replyRequests = (await api(`/assistants/${assistant.id}/requests`)).requests;
    assert.equal(replyRequests.length, 2);
    assert.equal(replyRequests.find((r) => r.text === replyEvent.ctx.BodyForCommands)?.status, 'completed');
    const ackReply = {
      ...replyEvent,
      ctx: {
        ...replyEvent.ctx,
        MessageSid: '458',
        ReplyToId: '10001',
        BodyForCommands: 'Reply with exactly ACK_FOLLOWUP_OK. Do not use tools.',
      },
    };
    assert.equal((await ingress(ackReply, context)).handled, true);
    await until(() => receipts.length === 3, 120000);
    assert.equal(receipts[2].text.trim(), 'ACK_FOLLOWUP_OK');
    assert.equal(
      (await ingress({ ...replyEvent, ctx: { ...replyEvent.ctx, MessageSid: '459', ReplyToId: '999999' } }, context))
        .handled,
      false
    );
    checks.push(
      'prefix-free replies to persisted result and acknowledgement route to same native conversation; duplicate accepted once; unknown replies fall through'
    );
  }

  if (process.argv.includes('--tables')) {
    assert.equal(whatsapp, true);
    const before = receipts.length;
    const tableEvent = {
      ...event,
      ctx: {
        ...event.ctx,
        media: [],
        MessageSid: 'TABLE01',
        BodyForCommands:
          'Brain, Return only a Markdown table with columns Item and State and exactly nine data rows Item1 through Item9, each with State Ready. No prose or code fence.',
      },
    };
    assert.equal((await ingress(tableEvent, context)).handled, true);
    await until(() => documents.length === 1 && receipts.length === before + 1, 120000);
    assert.match(receipts.at(-1).text, /9 rows/);
    assert.match(receipts.at(-1).text, /\*\*Item: Item1\*\*/);
    assert.equal(documents[0].to, sender);
    assert.equal(documents[0].data.split('\r\n').filter(Boolean).length, 10);
    assert.ok(!existsSync(documents[0].path));
    const completed = (await api(`/assistants/${assistant.id}/requests`)).requests.find(
      (r) => r.text === tableEvent.ctx.BodyForCommands.replace(/^Brain, /, '')
    );
    assert.equal(completed.status, 'completed');
    assert.match(completed.result.text, /\|.*Item.*\|.*State.*\|/);
    checks.push(
      'native table preserved in Codeman; WhatsApp receives readable row preview and full CSV through document adapter with private-file cleanup'
    );
  }

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
  if (process.argv.includes('--recovery')) {
    const originalBinding = assistant.binding;
    await api(`/sessions/${sessionId}`, 'DELETE');
    const recovered = await until(async () => {
      const current = await api(`/assistants/${assistant.id}`);
      return current.binding.sessionId !== sessionId && current.capabilities.requestExecution ? current : undefined;
    }, 240000);
    sessionId = recovered.binding.sessionId;
    const { layout: recoveredLayout } = await api('/tab-layout');
    assert.ok(
      recoveredLayout.groups
        .find((g) => g.id === recoveryGroupId)
        .refs.some((r) => r.kind === 'session' && r.id === sessionId)
    );
    if (process.argv.includes('--recovery-failure')) assert.equal(recovered.capabilities.recovery.attempts, 2);
    checks.push('automatic recovery preserves original group and explicitly resumes native conversation');

    assert.equal(recovered.binding.conversationId, originalBinding.conversationId);
    assert.equal(recovered.binding.codexHome, originalBinding.codexHome);
    assert.equal(recovered.binding.workingDir, originalBinding.workingDir);
    assert.equal(recovered.binding.generation, originalBinding.generation + 1);
    assert.equal(recovered.capabilities.inputLocked, true);
    const next = await api(`/assistants/${assistant.id}/requests`, 'POST', {
      text: 'Reply with exactly RECOVERY_OK. Do not use tools.',
      idempotencyKey: 'canary-recovery-proof',
    });
    const completed = await until(async () => {
      const r = await api(`/assistant-requests/${next.id}`);
      return r.status === 'completed' ? r : undefined;
    }, 120000);
    assert.equal(completed.result.text.trim(), 'RECOVERY_OK');
    checks.push(
      'deleted idle session automatically resumes exact native conversation, restores input lock and completes follow-up'
    );
    await page.evaluate(() => app.refreshAssistants());
    await page.screenshot({ path: join(root, 'recovered-assistant.png') });
  }
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
        channel,
        transport: 'test SDK adapter; no real channel credentials or poller',
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
  const recoveryCandidates = existsSync(join(data, 'assistant-recovery.json'))
    ? JSON.parse(readFileSync(join(data, 'assistant-recovery.json'), 'utf8'))
        .records.map((r) => r.candidateId)
        .filter(Boolean)
    : [];
  if (assistant) await api(`/assistants/${assistant.id}/take-control`, 'POST', {}).catch(() => {});
  for (const id of recoveryCandidates) if (id !== sessionId) await api(`/sessions/${id}`, 'DELETE').catch(() => {});
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
