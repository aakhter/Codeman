/** Stable assistant identities and scoped integration credentials. No request execution in phase 1. */
export type AssistantMode = 'codex' | 'claude' | 'opencode';
export interface AssistantBinding {
  /** Omitted on legacy Codex bindings for disk/API compatibility. */
  mode?: AssistantMode;
  sessionId: string;
  conversationId: string;
  /** Legacy field name: native Codex home, Claude config root or OpenCode XDG data root. */
  codexHome: string;
  workingDir: string;
  generation: number;
}

export interface AssistantDefinition {
  id: string;
  owner?: string;
  name: string;
  slug: string;
  mode: AssistantMode;
  enabled: boolean;
  binding?: AssistantBinding;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type AssistantScope = 'read' | 'submit' | 'cancel';
export interface AssistantToken {
  id: string;
  assistantId: string;
  owner?: string;
  name: string;
  hash: string;
  scopes: AssistantScope[];
  createdAt: number;
}

export interface AssistantPrincipal {
  tokenId: string;
  assistantId: string;
  owner?: string;
  scopes: AssistantScope[];
}
