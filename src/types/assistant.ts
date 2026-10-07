/** Stable assistant identities and scoped integration credentials. No request execution in phase 1. */
export interface AssistantBinding {
  sessionId: string;
  conversationId: string;
  codexHome: string;
  workingDir: string;
  generation: number;
}

export interface AssistantDefinition {
  id: string;
  owner?: string;
  name: string;
  slug: string;
  mode: 'codex';
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
