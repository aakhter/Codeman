/** Versioned assistant metadata; atomic, private, durable writes, fail closed on corruption. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { dataPath } from './config/instance.js';
import type { AssistantDefinition, AssistantPrincipal, AssistantScope, AssistantToken } from './types/assistant.js';

const BindingSchema = z
  .object({
    sessionId: z.string().min(1),
    conversationId: z.string().regex(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|ses_[A-Za-z0-9_-]{1,120})$/i),
    mode: z.enum(['codex', 'claude', 'opencode']).optional(),
    codexHome: z.string().min(1),
    workingDir: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
const DefinitionSchema = z
  .object({
    id: z.uuid(),
    owner: z.string().optional(),
    name: z.string().min(1).max(60),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
    mode: z.enum(['codex', 'claude', 'opencode']),
    enabled: z.boolean(),
    binding: BindingSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
const TokenSchema = z
  .object({
    id: z.uuid(),
    assistantId: z.uuid(),
    owner: z.string().optional(),
    name: z.string().min(1).max(60),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z
      .array(z.enum(['read', 'submit', 'cancel']))
      .min(1)
      .max(3),
    createdAt: z.number(),
  })
  .strict();
const FileSchema = z
  .object({
    version: z.literal(1),
    assistants: z.array(DefinitionSchema).max(200),
    tokens: z.array(TokenSchema).max(1000),
  })
  .strict();
type StoreFile = z.infer<typeof FileSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class AssistantStore {
  private state: StoreFile | undefined;
  constructor(private readonly path: string = dataPath('assistants.json')) {}

  private load(): StoreFile {
    if (this.state) return this.state;
    let next: StoreFile = { version: 1, assistants: [], tokens: [] };
    if (existsSync(this.path)) {
      try {
        next = FileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      } catch {
        throw new Error('Assistant store is unavailable; preserve and repair its state before continuing');
      }
    }
    if (
      new Set(next.assistants.map((a) => a.id)).size !== next.assistants.length ||
      new Set(next.assistants.map((a) => JSON.stringify([a.owner, a.slug]))).size !== next.assistants.length ||
      new Set(
        next.assistants
          .filter((a) => a.binding)
          .map((a) => JSON.stringify([a.binding!.codexHome, a.binding!.conversationId]))
      ).size !== next.assistants.filter((a) => a.binding).length ||
      new Set(next.tokens.map((t) => t.id)).size !== next.tokens.length ||
      next.tokens.some((t) => !next.assistants.some((a) => a.id === t.assistantId && a.owner === t.owner))
    ) {
      throw new Error('Assistant store contains invalid references');
    }
    this.state = next;
    return next;
  }

  private persist(next: StoreFile): void {
    FileSchema.parse(next);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      // Commit memory only once the atomic replacement exists. A later directory
      // sync failure is reported; retries must first reconcile the committed file.
      this.state = undefined;
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.state = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  list(): AssistantDefinition[] {
    return structuredClone(this.load().assistants);
  }
  get(id: string): AssistantDefinition | undefined {
    return this.list().find((a) => a.id === id);
  }
  save(assistant: AssistantDefinition): void {
    const next = structuredClone(this.load());
    const index = next.assistants.findIndex((a) => a.id === assistant.id);
    if (index < 0) next.assistants.push(structuredClone(assistant));
    else next.assistants[index] = structuredClone(assistant);
    if (next.assistants.some((a) => a.id !== assistant.id && a.owner === assistant.owner && a.slug === assistant.slug))
      throw new Error('Assistant slug is already used');
    if (
      assistant.binding &&
      next.assistants.some(
        (a) =>
          a.id !== assistant.id &&
          a.binding?.codexHome === assistant.binding?.codexHome &&
          a.binding?.conversationId === assistant.binding?.conversationId
      )
    )
      throw new Error('Conversation is already bound to an assistant');
    this.persist(next);
  }
  remove(id: string): void {
    const next = structuredClone(this.load());
    next.assistants = next.assistants.filter((a) => a.id !== id);
    next.tokens = next.tokens.filter((t) => t.assistantId !== id);
    this.persist(next);
  }
  issueToken(
    assistant: AssistantDefinition,
    name: string,
    scopes: AssistantScope[]
  ): { token: string; metadata: Omit<AssistantToken, 'hash'> } {
    const raw = `cma_${randomBytes(32).toString('base64url')}`;
    const record: AssistantToken = {
      id: randomUUID(),
      assistantId: assistant.id,
      owner: assistant.owner,
      name,
      scopes: [...new Set(scopes)],
      hash: digest(raw),
      createdAt: Date.now(),
    };
    const next = structuredClone(this.load());
    next.tokens.push(record);
    if (!next.assistants.some((a) => a.id === assistant.id && a.owner === assistant.owner))
      throw new Error('Assistant does not exist');
    this.persist(next);
    const { hash: _hash, ...metadata } = record;
    return { token: raw, metadata: structuredClone(metadata) };
  }
  listTokens(assistantId: string): Omit<AssistantToken, 'hash'>[] {
    return this.load()
      .tokens.filter((t) => t.assistantId === assistantId)
      .map(({ hash: _hash, ...publicToken }) => structuredClone(publicToken));
  }
  revokeToken(assistantId: string, id: string): boolean {
    const next = structuredClone(this.load());
    const before = next.tokens.length;
    next.tokens = next.tokens.filter((t) => t.id !== id || t.assistantId !== assistantId);
    if (next.tokens.length === before) return false;
    this.persist(next);
    return true;
  }
  authenticate(raw: string): AssistantPrincipal | undefined {
    if (!/^cma_[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const presented = Buffer.from(digest(raw), 'hex');
    const t = this.load().tokens.find((t) => timingSafeEqual(presented, Buffer.from(t.hash, 'hex')));
    if (!t || !this.load().assistants.some((a) => a.id === t.assistantId && a.owner === t.owner)) return undefined;
    return structuredClone({ tokenId: t.id, assistantId: t.assistantId, owner: t.owner, scopes: t.scopes });
  }
}
