import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './config/instance.js';
const Schema = z
  .object({
    id: z.uuid(),
    assistantId: z.uuid(),
    owner: z.string().optional(),
    tokenId: z.uuid().optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    text: z.string().min(1).max(20000),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      'queued',
      'dispatching',
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'outcome_unknown',
    ]),
    createdAt: z.number(),
    updatedAt: z.number(),
    deadline: z.number(),
    revision: z.number().int().positive(),
    binding: z
      .object({
        sessionId: z.string(),
        conversationId: z.string().regex(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|ses_[A-Za-z0-9_-]{1,120})$/i),
        mode: z.enum(['codex', 'claude', 'opencode']).optional(),
        codexHome: z.string(),
        workingDir: z.string(),
        generation: z.number().int().positive(),
      })
      .strict(),
    transcript: z
      .object({
        path: z.string(),
        anchor: z.string().optional(),
        offset: z.number().int().nonnegative(),
        inode: z.string(),
        device: z.string(),
      })
      .strict()
      .optional(),
    turnId: z.string().optional(),
    result: z
      .object({ text: z.string().max(1000000) })
      .strict()
      .optional(),
    reason: z.string().max(300).optional(),
    reconciled: z.boolean().optional(),
  })
  .strict();
const File = z.object({ version: z.literal(1), requests: z.array(Schema).max(1000) }).strict();
export type AssistantRequest = z.infer<typeof Schema>;
export class AssistantRequestStore {
  private records: AssistantRequest[];
  constructor(private readonly path = dataPath('assistant-requests.json')) {
    try {
      this.records = existsSync(path) ? File.parse(JSON.parse(readFileSync(path, 'utf8'))).requests : [];
    } catch {
      throw new Error('Assistant request ledger is unavailable; preserve it for reconciliation');
    }
    if (
      this.records.some(
        (r) =>
          r.payloadHash !== createHash('sha256').update(r.text).digest('hex') ||
          (r.status === 'completed' && !r.result) ||
          (['dispatching', 'running', 'awaiting_approval'].includes(r.status) && !r.transcript)
      ) ||
      new Set(this.records.map((r) => r.id)).size !== this.records.length ||
      new Set(this.records.map((r) => `${r.assistantId}:${r.idempotencyKey}`)).size !== this.records.length
    )
      throw new Error('Assistant ledger contains duplicate identities');
  }
  list(): AssistantRequest[] {
    return structuredClone(this.records);
  }
  get(id: string): AssistantRequest | undefined {
    return this.list().find((r) => r.id === id);
  }
  put(record: AssistantRequest): void {
    const next = this.list();
    const index = next.findIndex((r) => r.id === record.id);
    if (index < 0) next.push(structuredClone(record));
    else next[index] = structuredClone(record);
    File.parse({ version: 1, requests: next });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, requests: next }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      // A directory-sync failure must reconcile the already-replaced ledger before retrying.
      this.records = next;
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
