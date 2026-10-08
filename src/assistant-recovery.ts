/** Durable, bounded recovery of explicitly handed-off assistants. Never creates a fresh conversation. */
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from './config/instance.js';
import { CODEX_REASONING_EFFORTS } from './types.js';
import type { AssistantDefinition } from './types/assistant.js';
import type { AssistantExecutionSession, AssistantRequestManager } from './assistant-request-manager.js';
import { AssistantStore } from './assistant-store.js';
import { resolveAssistantBinding } from './assistant-registry.js';
import { findExactCodexConversation } from './checkpoint-conversation-identity.js';

const Profile = z
  .object({
    name: z.string().max(200),
    codexConfig: z
      .object({
        model: z.string().optional(),
        reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
        dangerouslyBypassApprovals: z.boolean().optional(),
        dangerouslyBypassHookTrust: z.boolean().optional(),
        animations: z.boolean().optional(),
        renderMode: z.literal('hybrid').optional(),
        baseCommand: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type AssistantRecoveryProfile = z.infer<typeof Profile>;
const Binding = z
  .object({
    sessionId: z.string(),
    conversationId: z.uuid(),
    codexHome: z.string(),
    workingDir: z.string(),
    generation: z.number().int().positive(),
  })
  .strict();
const RecordSchema = z
  .object({
    assistantId: z.uuid(),
    binding: Binding,
    profile: Profile,
    pid: z.number(),
    attempts: z.number().int().min(0).max(3),
    state: z.enum(['armed', 'recovering', 'blocked']),
    candidateId: z.string().optional(),
    startedAt: z.number().optional(),
    nextAt: z.number(),
    reason: z.string().optional(),
  })
  .strict();
type RecoveryRecord = z.infer<typeof RecordSchema>;
const FileSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(200) }).strict();
export interface AssistantRecoveryAdapter {
  snapshot(session: AssistantExecutionSession): AssistantRecoveryProfile;
  create(
    id: string,
    assistant: AssistantDefinition,
    profile: AssistantRecoveryProfile
  ): Promise<AssistantExecutionSession>;
  composerEmpty(session: AssistantExecutionSession): Promise<boolean>;
  ownerAllowed(assistant: AssistantDefinition): Promise<boolean>;
}
export class AssistantRecovery {
  private records: RecoveryRecord[];
  private busy = false;
  private automaticHandoff = false;
  private readonly startupAt = Date.now();
  constructor(
    private readonly assistants: AssistantStore,
    private readonly requests: AssistantRequestManager,
    private readonly session: (id: string) => AssistantExecutionSession | undefined,
    private readonly adapter: AssistantRecoveryAdapter,
    private readonly path = dataPath('assistant-recovery.json'),
    private readonly startupGraceMs = 60000
  ) {
    this.records = existsSync(path) ? FileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).records : [];
    if (new Set(this.records.map((r) => r.assistantId)).size !== this.records.length)
      throw new Error('Duplicate assistant recovery records');
    for (const r of this.records) if (r.candidateId) requests.holdRecoverySession(r.candidateId);
  }
  private save(): void {
    FileSchema.parse({ version: 1, records: this.records });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, records: this.records }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
  }
  status(id: string): { state: string; reason?: string; attempts: number } | undefined {
    const r = this.records.find((r) => r.assistantId === id);
    return r ? { state: r.state, reason: r.reason, attempts: r.attempts } : undefined;
  }
  arm(a: AssistantDefinition, session: AssistantExecutionSession): void {
    if (this.automaticHandoff) return;
    // Snapshot can reject credentials that cannot be restored without changing accounts.
    let profile: AssistantRecoveryProfile;
    let reason: string | undefined;
    try {
      profile = this.adapter.snapshot(session);
    } catch {
      profile = { name: a.name, codexConfig: {} };
      reason = 'Session credentials cannot be restored automatically; use desktop recovery';
    }
    this.records = this.records.filter((r) => r.assistantId !== a.id);
    this.records.push({
      assistantId: a.id,
      binding: structuredClone(a.binding!),
      profile,
      pid: session.pid!,
      attempts: 0,
      state: reason ? 'blocked' : 'armed',
      nextAt: 0,
      reason,
    });
    this.save();
  }
  disarm(id: string): void {
    const r = this.records.find((r) => r.assistantId === id);
    if (r?.candidateId) this.requests.releaseRecoverySession(r.candidateId);
    this.records = this.records.filter((r) => r.assistantId !== id);
    this.save();
  }
  private blocked(r: RecoveryRecord, reason: string): void {
    r.state = 'blocked';
    r.reason = reason;
    this.save();
  }
  async tick(): Promise<void> {
    if (this.busy || Date.now() - this.startupAt < this.startupGraceMs) return;
    this.busy = true;
    try {
      for (const r of [...this.records]) await this.recover(r);
    } finally {
      this.busy = false;
    }
  }
  private async recover(r: RecoveryRecord): Promise<void> {
    const a = this.assistants.get(r.assistantId);
    if (!a?.enabled || !a.binding || JSON.stringify(a.binding) !== JSON.stringify(r.binding)) return;
    if (r.state === 'blocked' || Date.now() < r.nextAt) return;
    const old = this.session(r.binding.sessionId);
    if (r.state === 'armed' && old?.pid === r.pid && !old.paneExit) return;
    // Uncertain work is never rebound or replayed. Desktop review must come first.
    if (this.requests.hasUnresolved(a.id))
      return this.blocked(r, 'Review interrupted or uncertain work before recovering this assistant');
    if (!(await this.adapter.ownerAllowed(a)))
      return this.blocked(r, 'Assistant owner is unavailable or no longer authorized');
    try {
      if ((await realpath(r.binding.workingDir)) !== r.binding.workingDir) throw new Error('Workspace changed');
      const native = await findExactCodexConversation({
        codexHome: r.binding.codexHome,
        workingDir: r.binding.workingDir,
        sessionId: r.binding.sessionId,
        nativeResumeId: r.binding.conversationId,
      });
      if (!native) return this.blocked(r, 'Original conversation is unavailable; choose recovery in the desktop');
      if (!(await this.requests.conversationReady(native.path)))
        return this.blocked(r, 'Original conversation has an unfinished turn; review it in the desktop');
      let candidate: AssistantExecutionSession | undefined;
      if (r.state === 'armed') {
        if (r.attempts >= 3) return this.blocked(r, 'Automatic recovery exhausted three attempts');
        r.attempts++;
        r.state = 'recovering';
        r.startedAt = Date.now();
        r.candidateId = old?.pid && !old.paneExit ? old.id : randomUUID();
        this.save();
        this.requests.holdRecoverySession(r.candidateId);
        candidate = old?.pid && !old.paneExit ? old : await this.adapter.create(r.candidateId, a, r.profile);
      } else candidate = this.session(r.candidateId!);
      if (!candidate || !candidate.pid || candidate.paneExit || candidate.status !== 'idle') {
        if (Date.now() - (r.startedAt ?? 0) > 60000) throw new Error('Recovered session did not become ready');
        return;
      }
      if (!(await this.adapter.composerEmpty(candidate))) {
        if (Date.now() - (r.startedAt ?? 0) > 60000) return this.blocked(r, 'Recovered composer needs desktop review');
        return;
      }
      const binding = await resolveAssistantBinding(candidate, r.binding.generation + 1);
      if (
        candidate.owner !== a.owner ||
        binding.conversationId !== r.binding.conversationId ||
        binding.codexHome !== r.binding.codexHome ||
        binding.workingDir !== r.binding.workingDir
      )
        return this.blocked(r, 'Recovered native identity changed; desktop review required');
      const latest = this.assistants.get(a.id);
      if (
        this.requests.hasUnresolved(a.id) ||
        !latest?.enabled ||
        latest.revision !== a.revision ||
        !this.records.includes(r) ||
        !(await this.adapter.ownerAllowed(latest))
      )
        return;
      this.requests.clearRecoveryHandoff(a.id);
      const next = { ...latest, binding, revision: latest.revision + 1, updatedAt: Date.now() };
      this.assistants.save(next);
      this.requests.rebindQueuedRecovery(a.id, r.binding, binding);
      r.binding = structuredClone(binding);
      this.save();
      this.automaticHandoff = true;
      try {
        await this.requests.handoff(next, next.revision, true);
      } finally {
        this.automaticHandoff = false;
      }
      r.state = 'armed';
      r.pid = candidate.pid;
      r.reason = undefined;
      r.candidateId = undefined;
      r.startedAt = undefined;
      this.requests.releaseRecoverySession(candidate.id);
      this.save();
    } catch {
      // Fixed message: launch errors can contain owner commands or credentials.
      r.reason = 'Recovery failed; waiting before retry. Open Assistants if review is needed';
      r.state = r.attempts >= 3 ? 'blocked' : 'armed';
      r.nextAt = Date.now() + 30000;
      if (r.candidateId) {
        // Never spawn over an existing candidate or abandon a potentially live process.
        const candidate = this.session(r.candidateId);
        if (candidate?.pid) r.state = 'blocked';
        else this.requests.releaseRecoverySession(r.candidateId);
      }
      this.save();
    }
  }
}

/* eslint-disable no-control-regex -- tmux SGR sequences carry composer placeholder styling. */
/** Accept only an empty Codex composer; dim placeholder text is not submitted input. */
export function assistantComposerEmpty(screen: string | null): boolean {
  if (!screen) return false;
  const lines = screen.split('\n').filter((line) =>
    line
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trimStart()
      .startsWith('›')
  );
  const line = lines.at(-1);
  if (!line) return false;
  let dim = false,
    after = false,
    visible = '';
  for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith('\x1b[')) {
      const codes = token
        .slice(2, -1)
        .split(';')
        .map((x) => Number(x || 0));
      if (codes.includes(0) || codes.includes(22)) dim = false;
      if (codes.includes(2)) dim = true;
    } else {
      let text = token;
      if (!after) {
        if (!text.includes('›')) continue;
        text = text.split('›').slice(1).join('›');
        after = true;
      }
      if (!dim) visible += text;
    }
  }
  return after && !visible.trim();
}
