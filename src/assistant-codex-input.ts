/** Subscribe to an already-loaded Codex daemon thread; never spawn a CLI or submit a turn. */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';

export const CodexQuestion = z.object({
  id: z.string().min(1).max(200),
  header: z.string().max(200),
  question: z.string().min(1).max(10000),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z
    .array(z.object({ label: z.string().max(500), description: z.string().max(2000) }))
    .max(30)
    .nullish(),
});
export const CodexInput = z.object({
  kind: z.enum(['blocking', 'async']).optional(),
  requestId: z.union([z.string().min(1).max(200), z.number().int()]),
  threadId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  itemId: z.string().min(1).max(200),
  isBlocking: z.boolean(),
  questions: z.array(CodexQuestion).min(1).max(10),
});
export type CodexPendingInput = z.infer<typeof CodexInput>;
export const codexQuestionKey = (q: CodexPendingInput): string =>
  createHash('sha256')
    .update(JSON.stringify([q.threadId, q.turnId, q.itemId]))
    .digest('hex');
export type CodexAnswers = Record<string, { answers: string[] }>;

export class CodexInputBridge {
  private socket: WebSocket | undefined;
  private sequence = 0;
  private pending = new Map<string, CodexPendingInput>();
  private calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private resolved = new Set<string>();
  private ready: Promise<void> | undefined;
  private closed = false;
  constructor(
    private readonly home: string,
    private readonly threadId: string,
    private readonly cwd: string
  ) {}
  private key(id: string | number): string {
    return JSON.stringify(id);
  }
  private async connect(): Promise<void> {
    const path = join(this.home, 'app-server-control', 'app-server-control.sock');
    if (!(await stat(path)).isSocket()) throw new Error('Codex daemon socket unavailable');
    const s = new WebSocket(`ws+unix://${path}:/`, { maxPayload: 20 * 1024 * 1024, handshakeTimeout: 5000 });
    this.socket = s;
    s.on('message', (bytes) => {
      try {
        const v = JSON.parse(bytes.toString());
        const call = this.calls.get(String(v.id));
        if (!v.method && call) {
          this.calls.delete(String(v.id));
          if (v.error) call.reject(new Error('Codex daemon request rejected'));
          else call.resolve(v.result);
        } else if (v.method === 'item/tool/requestUserInput') {
          const parsed = CodexInput.safeParse({ ...v.params, requestId: v.id });
          if (parsed.success && parsed.data.threadId === this.threadId) this.pending.set(this.key(v.id), parsed.data);
        } else if (v.method === 'serverRequest/resolved' && v.params?.threadId === this.threadId) {
          const key = this.key(v.params.requestId);
          this.pending.delete(key);
          this.resolved.add(key);
        }
      } catch {
        /* Unsupported events never authorize an answer. */
      }
    });
    const fail = () => {
      if (this.socket !== s) return;
      this.ready = undefined;
      this.pending.clear();
      for (const call of this.calls.values()) call.reject(new Error('Codex daemon disconnected'));
      this.calls.clear();
    };
    s.on('close', fail);
    s.on('error', fail);
    await new Promise<void>((resolve, reject) => {
      s.once('open', resolve);
      s.once('error', reject);
    });
    const initialized = (await this.rpc('initialize', {
      clientInfo: { name: 'codeman_assistant_questions', version: '1' },
      capabilities: { experimentalApi: true },
    })) as { codexHome?: string };
    if (!initialized.codexHome || (await realpath(initialized.codexHome)) !== (await realpath(this.home)))
      throw new Error('Codex daemon home mismatch');
    s.send(JSON.stringify({ method: 'initialized' }));
    const read = (await this.rpc('thread/read', { threadId: this.threadId, includeTurns: false })) as {
      thread?: { id: string; cwd: string; status?: { type: string } };
    };
    if (
      read.thread?.id !== this.threadId ||
      read.thread.status?.type === 'notLoaded' ||
      (await realpath(read.thread.cwd)) !== this.cwd
    )
      throw new Error('Exact loaded Codex thread unavailable');
    // No overrides: subscribe to the existing loaded thread and replay unresolved server requests.
    await this.rpc('thread/resume', { threadId: this.threadId, excludeTurns: true });
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `codeman-input-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error('Codex daemon timed out'));
      }, 5000);
      this.calls.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async inputs(turnId: string): Promise<CodexPendingInput[]> {
    if (this.closed) return [];
    this.ready ??= this.connect().catch((e) => {
      this.socket?.terminate();
      this.ready = undefined;
      throw e;
    });
    await this.ready;
    return [...this.pending.values()].filter((q) => q.turnId === turnId).map((q) => structuredClone(q));
  }
  async asyncPending(input: CodexPendingInput): Promise<boolean> {
    await this.inputs(input.turnId);
    const page = (await this.rpc('thread/items/list', {
      threadId: this.threadId,
      turnId: input.turnId,
      cursor: { type: 'item', itemId: input.itemId },
      limit: 100,
    })) as {
      data?: Array<{ turnId?: string; item?: { type?: string; delivery?: string; questions?: unknown[] } }>;
      nextCursor?: string | null;
    };
    // Fail closed when the bounded page cannot establish absence of newer user input.
    return (
      Array.isArray(page.data) &&
      !page.nextCursor &&
      !page.data.some(
        (v) =>
          v.turnId !== input.turnId ||
          v.item?.type === 'userMessage' ||
          (v.item?.delivery === 'async' && v.item.questions?.length)
      )
    );
  }
  async answer(input: CodexPendingInput, answers: CodexAnswers, clientId?: string, text?: string): Promise<void> {
    if (input.kind === 'async') {
      if (!clientId || !text || !(await this.asyncPending(input)))
        throw new Error('Async question is no longer pending');
      const response = (await this.rpc('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: input.turnId,
        clientUserMessageId: clientId,
        input: [{ type: 'text', text, text_elements: [] }],
      })) as { turnId?: string };
      if (response.turnId !== input.turnId) throw new Error('Native answer turn changed');
      return;
    }
    const current = (await this.inputs(input.turnId)).find((q) => this.key(q.requestId) === this.key(input.requestId));
    if (!current || JSON.stringify(current) !== JSON.stringify(input)) throw new Error('Question is no longer pending');
    const key = this.key(input.requestId);
    this.resolved.delete(key);
    this.socket!.send(JSON.stringify({ id: input.requestId, result: { answers } }));
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (this.resolved.has(key)) return;
      if (this.socket?.readyState !== WebSocket.OPEN) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Native question response outcome is unknown; check Codeman before retrying');
  }
  close(): void {
    this.closed = true;
    this.socket?.close();
    this.pending.clear();
  }
}
