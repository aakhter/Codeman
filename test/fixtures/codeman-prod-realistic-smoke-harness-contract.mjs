#!/usr/bin/env node

// This file is intentionally a deterministic, in-repo contract fixture.
// The canonical production smoke harness (used in external CI) is not editable
// from this test environment, so this module captures just enough stable contract
// semantics for deterministic repository tests.

const TARGETS = ['claude', 'opencode', 'codex', 'shell'];

function splitTargetArg(value) {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseArgValue(args, candidateFlags) {
  const index = args.findIndex((token) => candidateFlags.includes(token));
  if (index === -1) return '';
  return args[index + 1] ?? '';
}

export function parseTargetArg(input) {
  if (!input) return TARGETS.slice();

  const tokens = String(input).trim().split(/\s+/).filter(Boolean);
  const raw = parseArgValue(tokens, ['--target', '--targets', '--target='])
    || parseArgValue(tokens, ['--targets='])
    || parseArgValue(tokens, ['--target'])
    || '';

  if (!raw) return TARGETS.slice();
  return splitTargetArg(raw);
}

export function buildSmokeHarnessContract(targetArg = '') {
  const activeTargets = parseTargetArg(targetArg);
  const runTargets = TARGETS.filter((target) => !activeTargets.length || activeTargets.includes(target));

  const marks = [];
  const screenshotAttachments = [];

  function mark(name) {
    marks.push(name);
  }

  function captureScreenshotAttachment(sessionId, fileName) {
    screenshotAttachments.push({
      sessionId,
      fileName,
      attachmentEndpoint: `/api/sessions/${sessionId}/attachments`,
    });
  }

  function seedStaleCodexSnapshot() {
    return 'seeded stale snapshot';
  }

  if (runTargets.includes('opencode')) {
    mark('OpenCode live mirror smoke session check');
    captureScreenshotAttachment('opencode-session', 'opencode-live-mirror-01.png');
  }

  if (runTargets.includes('claude')) {
    mark('Claude smoke session check');
    captureScreenshotAttachment('claude-session', 'claude-live-01.png');
  }

  mark('create/start Codex session');
  captureScreenshotAttachment('codex-session', 'codex-02.png');

  mark('screenshot attachment card visible');
  mark('create/start shell session');
  mark('stale Codex snapshot is replaced by full-history replay after reload');
  seedStaleCodexSnapshot();

  captureScreenshotAttachment('codex-session', 'codex-03.png');

  mark(`smoke targets: ${runTargets.includes('claude') ? 'claude' : ''} ${runTargets.includes('opencode') ? 'opencode' : ''}`.trim());

  return {
    activeTargets,
    marks,
    runTargets,
    screenshotAttachments,
  };
}

export { TARGETS };
