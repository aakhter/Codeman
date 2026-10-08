/** Named assistant metadata and exact local Codex binding. */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { AssistantStore } from './assistant-store.js';
import { findExactCodexConversation, resolveEffectiveCodexHome } from './checkpoint-conversation-identity.js';
import type { AssistantDefinition, AssistantBinding } from './types/assistant.js';

export class AssistantConflict extends Error {}
export interface AssistantSession {
  id: string;
  owner?: string;
  mode: string;
  workingDir: string;
  status: string;
  pid: number | null;
  paneExit?: { at: number };
  remote?: unknown;
  docker?: unknown;
  nativeResumeId?: string | null;
  codexConfig?: { resumeSessionId?: string };
  getCodexHomeOverride(): string | undefined;
  hasLostCodexProviderCredentials(): boolean;
}

export async function resolveAssistantBinding(
  session: AssistantSession,
  generation: number
): Promise<AssistantBinding> {
  if (
    session.mode !== 'codex' ||
    session.remote ||
    session.docker ||
    !session.pid ||
    session.paneExit ||
    session.status !== 'idle' ||
    session.hasLostCodexProviderCredentials()
  )
    throw new AssistantConflict('Binding requires an idle, running local Codex session with available credentials');
  const codexHome = resolveEffectiveCodexHome(session.getCodexHomeOverride(), session.workingDir);
  const workingDir = await realpath(session.workingDir);
  const conversation = await findExactCodexConversation({
    codexHome,
    sessionId: session.id,
    workingDir,
    nativeResumeId: session.nativeResumeId ?? undefined,
    resumeSessionId: session.codexConfig?.resumeSessionId,
  });
  if (!conversation) throw new AssistantConflict('Exact conversation identity is unavailable or ambiguous');
  return { sessionId: session.id, conversationId: conversation.id, codexHome, workingDir, generation };
}

export class AssistantRegistry {
  // The request engine supplies the durable outstanding-work and handoff guard.
  constructor(
    readonly store: AssistantStore,
    private readonly hasOutstandingRequests: (id: string) => boolean = () => false
  ) {}
  create(owner: string | undefined, name: string, slug: string): AssistantDefinition {
    if (this.store.list().some((a) => a.owner === owner && a.slug === slug))
      throw new AssistantConflict('Assistant slug is already used');
    const now = Date.now();
    const a: AssistantDefinition = {
      id: randomUUID(),
      owner,
      name,
      slug,
      mode: 'codex',
      enabled: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.save(a);
    return a;
  }
  update(
    current: AssistantDefinition,
    revision: number,
    changes: { name?: string; enabled?: boolean }
  ): AssistantDefinition {
    const latest = this.store.get(current.id);
    if (!latest || latest.revision !== revision)
      throw new AssistantConflict('Assistant revision changed; reload before updating');
    if (changes.enabled && !latest.binding)
      throw new AssistantConflict('Bind an existing session before enabling the assistant');
    const next = { ...latest, ...changes, revision: latest.revision + 1, updatedAt: Date.now() };
    this.store.save(next);
    return next;
  }
  remove(current: AssistantDefinition, revision: number): void {
    const latest = this.store.get(current.id);
    if (!latest || latest.revision !== revision) throw new AssistantConflict('Assistant revision changed');
    if (latest.enabled || this.hasOutstandingRequests(current.id))
      throw new AssistantConflict('Disable the assistant and reconcile requests before deleting it');
    this.store.remove(current.id);
  }
  async bind(
    current: AssistantDefinition,
    revision: number,
    generation: number,
    session: AssistantSession
  ): Promise<AssistantDefinition> {
    if (session.owner !== current.owner) throw new AssistantConflict('Assistant and session ownership must match');
    if (this.hasOutstandingRequests(current.id))
      throw new AssistantConflict('Reconcile outstanding requests before changing the binding');
    const initialWorkingDir = session.workingDir;
    const initialNativeId = session.nativeResumeId;
    const initialResumeId = session.codexConfig?.resumeSessionId;
    const binding = await resolveAssistantBinding(session, generation + 1);
    const latest = this.store.get(current.id);
    if (
      !latest ||
      latest.revision !== revision ||
      (latest.binding?.generation ?? 0) !== generation ||
      this.hasOutstandingRequests(current.id)
    )
      throw new AssistantConflict('Assistant binding changed or has outstanding requests');
    // Revalidate the same mutable live object after the filesystem await.
    if (
      session.owner !== latest.owner ||
      session.status !== 'idle' ||
      !session.pid ||
      session.paneExit ||
      session.mode !== 'codex' ||
      session.remote ||
      session.docker ||
      session.hasLostCodexProviderCredentials() ||
      resolveEffectiveCodexHome(session.getCodexHomeOverride(), session.workingDir) !== binding.codexHome ||
      session.workingDir !== initialWorkingDir ||
      session.nativeResumeId !== initialNativeId ||
      session.codexConfig?.resumeSessionId !== initialResumeId
    )
      throw new AssistantConflict('Session changed while binding');
    if (
      this.store
        .list()
        .some(
          (a) =>
            a.id !== latest.id &&
            a.binding?.codexHome === binding.codexHome &&
            a.binding.conversationId === binding.conversationId
        )
    )
      throw new AssistantConflict('Conversation is already bound');
    const next = { ...latest, binding, revision: latest.revision + 1, updatedAt: Date.now() };
    this.store.save(next);
    return next;
  }
}
