/** COD-486: exact conversation resumption after a verified worker reboot. */
import { createRecoveryRecord } from './session-recovery.js';
import type { SessionState } from './types/session.js';
import type { RespawnPaneOptions } from './mux-interface.js';

import { getCli } from './config/cli-registry/registry.js';
import { matchesPattern } from './config/cli-registry/patterns.js';

/** Never guess a conversation from cwd, or execute an opaque launcher on a timer. */
export function workerResumeOptions(
  options: RespawnPaneOptions,
  nativeResumeId: string | null
): RespawnPaneOptions | null {
  const remote = options.remote;
  if (!remote || remote.owned === false || remote.remoteSessionName || remote.commands?.[options.mode]) return null;
  const entry = getCli(options.mode);
  const overlay = entry?.overlays.remote;
  if (!entry || !overlay || 'disabled' in overlay || !overlay.workerRebootResume) return null;
  const pattern = entry.launch.params.resumeId;
  if (pattern?.type !== 'token') return null;
  const result = { ...options, remoteResumeOnly: true };
  if (overlay.workerRebootResume === 'pinned-session') {
    const id = options.resumeSessionId ?? options.sessionId;
    return matchesPattern(pattern.pattern, id) ? { ...result, resumeSessionId: id } : null;
  }
  const field = entry.launch.legacyConfigField;
  const alias = entry.launch.legacyConfigAliases?.resumeId;
  if (!field || !alias || overlay.fromLaunchSpec !== true) return null;
  const config = (options as unknown as Record<string, unknown>)[field] as Record<string, unknown> | undefined;
  if (entry.launch.rawCommandField && config?.[entry.launch.rawCommandField]) return null;
  const id = nativeResumeId ?? config?.[alias];
  if (typeof id !== 'string' || !matchesPattern(pattern.pattern, id)) return null;
  return { ...result, [field]: { ...config, [alias]: id } };
}

/** A failed worker resume remains actionable through the existing Recovery Queue. */
export function createWorkerRecoveryRecord(state: SessionState) {
  const record = createRecoveryRecord(state);
  const pinned = workerResumeOptions(
    {
      ...state,
      sessionId: state.id,
      mode: state.mode ?? 'shell',
      resumeSessionId: record.claudeResumeId ?? state.resumeSessionId,
    },
    state.nativeResumeId ?? null
  );
  if (!pinned) {
    record.status = 'manual_required';
    record.launch = {
      kind: 'manual_required',
      hint: 'Exact remote conversation identity or supported launcher is unavailable. Resume manually on the worker.',
    };
    return record;
  }
  const entry = getCli(pinned.mode);
  const overlay = entry?.overlays.remote;
  if (overlay && !('disabled' in overlay) && overlay.workerRebootResume === 'pinned-session') {
    record.claudeResumeId = pinned.resumeSessionId;
  } else {
    const field = entry?.launch.legacyConfigField;
    const alias = entry?.launch.legacyConfigAliases?.resumeId;
    const config = field
      ? ((pinned as unknown as Record<string, unknown>)[field] as Record<string, unknown>)
      : undefined;
    const id = alias ? config?.[alias] : undefined;
    if (typeof id === 'string') record.nativeResumeId = id;
  }
  record.status = 'resumable';
  return record;
}
