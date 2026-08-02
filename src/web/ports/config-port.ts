/**
 * @fileoverview Config port — capabilities for app configuration and settings.
 * Route modules that read or modify configuration depend on this port.
 */

import type { ClaudeMode, NiceConfig } from '../../types.js';
import type { StateStore } from '../../state-store.js';
import type { TerminalHistoryConfig } from '../../config/terminal-history.js';

export interface ConfigPort {
  readonly store: StateStore;
  readonly port: number;
  readonly https: boolean;
  readonly testMode: boolean;
  readonly serverStartTime: number;
  getGlobalNiceConfig(): Promise<NiceConfig | undefined>;
  getModelConfig(): Promise<{ defaultModel?: string; agentTypeOverrides?: Record<string, string> } | null>;
  getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }>;
  getTerminalHistoryConfig(): Promise<TerminalHistoryConfig>;
  /** COD-75: whether new Claude/non-codex sessions opt into COLORTERM=truecolor (settings.json, default off). */
  getTruecolorEnabled(): Promise<boolean>;
  /** COD-257: whether newly created sessions enable Agent Checkpoint (settings.json, default on). */
  getCheckpointDefaultEnabled(): Promise<boolean>;
  getDefaultClaudeMdPath(): Promise<string | undefined>;
  getLightState(identity?: { username: string; role: 'admin' | 'user' }): unknown;
  getLightSessionsState(): unknown[];
  startTranscriptWatcher(sessionId: string, transcriptPath: string): void;
  stopTranscriptWatcher(sessionId: string): void;
}
