/**
 * @fileoverview Short-lived, bounded guarded prompt receipts. No prompt content is
 * retained: only caller/session identity, lifecycle/input revisions and SHA-256.
 * A receipt is consumed synchronously before verification/delivery, including failures.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stripAnsi, SPINNER_PATTERN } from './utils/regex-patterns.js';
import { visibleWidth } from './tui/tui-ansi.js';
export const STAGE_MAX_BYTES = 8192;
export const promptSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface GuardedInputSnapshot {
  generation: string;
  revision: number;
  composerSha: string;
}
export interface GuardedInputTarget {
  id: string;
  snapshot(): GuardedInputSnapshot | null;
  write(text: string): Promise<boolean>;
  submit(expected: GuardedInputSnapshot): Promise<boolean>;
}
interface Receipt extends GuardedInputSnapshot {
  owner: string;
  sessionId: string;
  expiresAt: number;
  sha256: string;
}
export class GuardedInputConflict extends Error {}

/**
 * Conservatively read a Codex composer: exactly one visible, unwrapped row and a
 * known footer. Never remove internal spaces, infer an unknown shell prompt, or
 * interpret dialog options as authority. An unsupported frame yields no proof.
 */
export function readGuardedCodexComposer(screen: string): string | null {
  const lines = stripAnsi(screen)
    .split('\n')
    .map((line) => line.trimEnd());
  const rows = lines.map((line, index) => ({ line, index })).filter((row) => /^\s*›(?:\s|$)/.test(row.line));
  const last = rows.at(-1);
  if (!last) return null;
  const below = lines.slice(last.index + 1).filter((line) => line.trim());
  if (
    below.length === 0 ||
    below.length > 3 ||
    below.some(
      (line) =>
        !/^\s+(?:\d+% context left|\? for shortcuts|← for agents|\S+ (?:default|low|medium|high|xhigh|max) · )/.test(
          line
        )
    )
  )
    return null;
  return withoutDimText(screen.split('\n')[last.index]).trimStart().slice(2).trimEnd();
}

function withoutDimText(raw: string): string {
  // Preserve exact printable content; only SGR-dim placeholder/suggestion text is excluded.
  let dim = false;
  let visible = '';
  // eslint-disable-next-line no-control-regex
  for (const token of raw.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    if (/^\x1b\[/.test(token)) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        // Extended color payloads may contain 0, 2 or 22; those are not SGR modes.
        if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
          i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        } else if (codes[i] === 0 || codes[i] === 22) dim = false;
        else if (codes[i] === 2) dim = true;
      }
    } else if (!dim) visible += token;
  }
  return stripAnsi(visible);
}

export type GuardedComposerProfile = 'codex' | 'claude';

/** A conventional file terminator is not part of a prompt; remove exactly one. */
export function normalizeGuardedMessageFile(message: string): string {
  return message.endsWith('\r\n') ? message.slice(0, -2) : message.endsWith('\n') ? message.slice(0, -1) : message;
}

/** Shared local/API prompt validation, independent of the delivery transport. */
export function guardedMessageRefusal(message: string, multiline = false): string | undefined {
  // LF is allowed only with explicit multiline authorization; CR, tabs and terminal controls never are.
  // eslint-disable-next-line no-control-regex
  const controls = multiline ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/;
  if (!message || Buffer.byteLength(message) > STAGE_MAX_BYTES || Buffer.from(message).toString('utf8') !== message)
    return 'Stage requires nonempty UTF8 input within 8192 bytes';
  if (controls.test(message))
    return 'Stage refuses terminal controls; newline requires explicit multiline authorization';
  if (message.split('\n').some((line) => line !== line.trimEnd()) || message.endsWith('\n'))
    return 'Stage refuses trailing whitespace on any line';
  return undefined;
}

/** Require an exact, supported visible composer and caret. Wrapped or collapsed pastes fail closed. */
export function readGuardedComposerSnapshot(
  snapshot: string,
  profile: GuardedComposerProfile,
  multiline = false
): string | null {
  // formatPaneSnapshot emits one absolute row address per line, then the caret.
  // eslint-disable-next-line no-control-regex
  const positions = [...snapshot.matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (positions.length < 2) return null;
  const caret = positions.at(-1)!;
  if (caret.index! + caret[0].length !== snapshot.length) return null;
  const rows: string[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const position = positions[i];
    if (Number(position[1]) !== i + 1 || position[2] !== '1') return null;
    rows.push(snapshot.slice(position.index! + position[0].length, positions[i + 1].index));
  }
  const plain = rows.map((row) => stripAnsi(row));
  let start = -1,
    end = -1;
  let composer: string | null = null;
  let prefix: string | undefined;
  if (profile === 'codex') {
    for (let i = plain.length - 1; i >= 0; i--)
      if (/^\s*›(?:\s|$)/.test(plain[i])) {
        start = i;
        break;
      }
    if (start < 0) return null;
    const footer = plain.findIndex(
      (line, index) =>
        index > start &&
        /^\s+(?:\d+% context left|\? for shortcuts|← for agents|\S+ (?:default|low|medium|high|xhigh|max) · )/.test(
          line
        )
    );
    if (footer < 0) return null;
    end = footer - 1;
    while (end > start && !plain[end].trim()) end--;
    if (end === start) composer = readGuardedCodexComposer(rows.slice(start).join('\n'));
    else {
      if (!multiline || plain.slice(start + 1, end + 1).some((line) => line && !line.startsWith('  '))) return null;
      const first = readGuardedCodexComposer([rows[start], ...rows.slice(footer)].join('\n'));
      if (first === null) return null;
      composer = [first, ...plain.slice(start + 1, end + 1).map((line) => line.slice(2).trimEnd())].join('\n');
    }
    prefix = plain[start].match(/^(\s*›[ \u00a0])/)?.[1];
    if (!prefix && /^\s*›$/.test(plain[start]) && composer === '') prefix = `${plain[start]} `;
  } else if (profile === 'claude') {
    // The bordered composer and permission-cycle footer distinguish it from trust/approval menus.
    for (let i = plain.length - 1; i >= 0; i--)
      if (/^❯(?:[ \u00a0]|$)/.test(plain[i])) {
        start = i;
        break;
      }
    if (start < 1 || !/^─{4,}\s*$/.test(plain[start - 1])) return null;
    const border = plain.findIndex((line, index) => index > start && /^─{4,}\s*$/.test(line));
    if (border < 0) return null;
    const footer = plain.slice(border + 1).filter((line) => line.trim());
    // A user-configured statusLine may occupy one opaque row before the final
    // permission-cycle footer; it is display data, never authorization or prompt text.
    if (footer.length < 1 || footer.length > 2 || !/^\s*[⏵⏸]+ .*\(shift\+tab to cycle\)\s*$/.test(footer.at(-1)!))
      return null;
    if (
      plain
        .slice(0, start - 1)
        .some((line) => SPINNER_PATTERN.test(line) || /(?:esc to interrupt|[✻✽✶✳✢·∗] .*[.…])/i.test(line))
    )
      return null;
    end = border - 1;
    if ((!multiline && end !== start) || plain.slice(start + 1, end + 1).some((line) => line && !line.startsWith('  ')))
      return null;
    prefix = plain[start].match(/^(❯[ \u00a0]?)/)?.[1];
    if (plain[start] === '❯') prefix = '❯ ';
    composer = [
      withoutDimText(rows[start])
        .slice(prefix?.length ?? 0)
        .trimEnd(),
      ...plain.slice(start + 1, end + 1).map((line) => line.slice(2).trimEnd()),
    ].join('\n');
  } else return null;
  if (composer === null || !prefix || Number(caret[1]) !== end + 1) return null;
  const lastLine = composer.split('\n').at(-1)!;
  const linePrefix = end === start ? prefix : '  ';
  if (Number(caret[2]) !== visibleWidth(linePrefix + lastLine) + 1) return null;
  return composer;
}

/** Backward-compatible single-line Codex verifier. */
export function readGuardedCodexSnapshot(snapshot: string): string | null {
  return readGuardedComposerSnapshot(snapshot, 'codex');
}

export class GuardedStageStore {
  private readonly receipts = new Map<string, Receipt>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly ttlMs = 120000
  ) {}
  async stage(target: GuardedInputTarget, owner: string, message: string, options: { multiline?: boolean } = {}) {
    const refusal = guardedMessageRefusal(message, options.multiline);
    if (refusal) throw new GuardedInputConflict(refusal);
    const key = target.id;
    if (this.busy.has(key)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(key);
    try {
      const before = target.snapshot();
      if (!before || before.composerSha !== promptSha256(''))
        throw new GuardedInputConflict('An empty, verifiable composer is required');
      for (const [id, receipt] of this.receipts)
        if (receipt.expiresAt <= this.now() || receipt.sessionId === target.id) this.receipts.delete(id);
      // Refuse capacity before typing. Do not evict a caller's still-live receipt.
      // Include in-flight stages (this operation already owns one busy slot),
      // so different sessions cannot type concurrently into the same last slot.
      if (this.receipts.size + this.busy.size > this.capacity)
        throw new GuardedInputConflict('Guarded stage receipt capacity reached');
      if (!(await target.write(message)))
        throw new GuardedInputConflict('Staging delivery failed; inspect the pane before trying again');
      const after = target.snapshot();
      if (!after || after.generation !== before.generation || after.revision !== before.revision + 1)
        throw new GuardedInputConflict('Input or pane changed while staging; no receipt was issued');
      const stageId = randomUUID();
      const expiresAt = this.now() + this.ttlMs;
      const sha256 = promptSha256(message);
      this.receipts.set(stageId, { ...after, owner, sessionId: target.id, expiresAt, sha256 });
      return { stageId, sha256, expiresAt, sessionId: target.id, submitted: false as const };
    } finally {
      this.busy.delete(key);
    }
  }
  async submit(target: GuardedInputTarget, owner: string, stageId: string, confirmSha: string) {
    const receipt = this.receipts.get(stageId);
    if (!receipt || receipt.owner !== owner || receipt.sessionId !== target.id)
      throw new GuardedInputConflict('Unknown, used, or foreign stage receipt');
    // One shot, even a wrong hash or unprovable composer. No retry of ambiguous Enter.
    this.receipts.delete(stageId);
    if (this.busy.has(target.id)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(target.id);
    try {
      if (receipt.expiresAt <= this.now() || receipt.sha256 !== confirmSha)
        throw new GuardedInputConflict('Expired stage receipt or confirmation hash mismatch');
      const current = target.snapshot();
      if (
        !current ||
        current.generation !== receipt.generation ||
        current.revision !== receipt.revision ||
        current.composerSha !== receipt.sha256
      )
        throw new GuardedInputConflict('Staged composer, input, or pane identity changed; nothing submitted');
      if (!(await target.submit(current)))
        throw new GuardedInputConflict('Submission delivery failed or ambiguous; receipt consumed, inspect the pane');
      return { stageId, sessionId: target.id, submitted: true as const };
    } finally {
      this.busy.delete(target.id);
    }
  }
  clear(): void {
    this.receipts.clear();
    this.busy.clear();
  }
}
