/**
 * @fileoverview Implementation-review checkpoint contract (COD-265).
 *
 * The machine-readable boundary between an implementation session and its
 * reviewer. Binds a task, its implementor session, the worktree, the base and
 * checkpoint commits, the handoff, the readiness target and the evidence
 * references into ONE validated identity that the Orchestrator can persist and
 * reload across a restart.
 *
 * ⚠️ This is a CONTRACT, not an engine. Codeman already has exactly one
 * checkpoint state machine — the agent-initiated compact/clear/new sequencer in
 * `session-auto-ops.ts`, which owns `runId`, `CheckpointPhase` and the terminal
 * driving. Nothing here drives a terminal, holds a timer or advances a phase; a
 * review checkpoint merely *references* that engine's `runId`. Adding a second
 * state machine is explicitly out of scope, because two engines racing over one
 * pane is how a checkpoint gets driven twice.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. **Identity is derived from the binding, never from the event.** Duplicate
 *    checkpoint events for one piece of work must collapse to a single record.
 *    Hashing the incidental fields (timestamp, prose handoff) instead would mint
 *    a fresh id per delivery and the audit trail would grow a row per retry.
 *
 * 2. **Validation fails closed.** Anything incomplete, contradictory,
 *    superseded, or written by a schema we do not understand cannot advance.
 *    Advancement is opt-in on a fully-understood record, never opt-out on a
 *    suspicious one.
 *
 * Pure and IO-free by design, so it is unit-testable without a session, a
 * worktree or a Jira round-trip. Persisted inside the existing
 * `OrchestratorPersistState` (see `types/orchestrator.ts`) rather than in a new
 * store — there is one orchestrator state file and this belongs in it.
 */

import { createHash } from 'node:crypto';

/**
 * Persisted shape version. Bump when a field's MEANING changes; adding an
 * optional field does not require a bump because unknown fields are ignored on
 * read and absent ones are defaulted.
 */
export const REVIEW_CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Which kind of checkpoint a `runId` represents.
 *
 * `context-management` is the pre-existing behaviour: an agent-initiated
 * compact/clear/new whose only purpose is to reclaim context. It is the DEFAULT
 * for any run we hold no review record for, which is what keeps every existing
 * checkpoint unchanged by this feature.
 */
export type CheckpointKind = 'context-management' | 'implementation-review';

/** Evidence references backing a review checkpoint. Paths and labels, not blobs. */
export interface ReviewCheckpointEvidence {
  changedFiles: string[];
  commands: string[];
  testResults: string[];
  deferredWork: string[];
}

/** Everything needed to mint a review checkpoint. */
export interface ReviewCheckpointInput {
  /** The EXISTING session-auto-ops checkpoint run this review is attached to. */
  runId: string;
  taskId: string;
  implementorSessionId: string;
  worktree: string;
  baseCommit: string;
  checkpointCommit: string;
  handoff: string;
  readinessTarget: string;
  dirtyWorktree: boolean;
  createdAt: number;
  evidence: ReviewCheckpointEvidence;
}

/** A persisted implementation-review checkpoint. */
export interface ReviewCheckpoint extends ReviewCheckpointInput {
  schemaVersion: number;
  id: string;
  kind: 'implementation-review';
  /** Set when a newer checkpoint for the same task+session has replaced this one. */
  superseded: boolean;
}

export type ReviewCheckpointValidationCode =
  | 'missing-task'
  | 'missing-session'
  | 'missing-worktree'
  | 'missing-base-commit'
  | 'missing-checkpoint-commit'
  | 'missing-handoff'
  | 'missing-readiness-target'
  | 'dirty-worktree'
  | 'inconsistent-evidence'
  | 'unsupported-schema-version';

export interface ReviewCheckpointValidation {
  valid: boolean;
  errors: ReviewCheckpointValidationCode[];
}

/** The binding fields, in a fixed order. Changing this changes every identity. */
const IDENTITY_FIELDS = [
  'taskId',
  'implementorSessionId',
  'worktree',
  'baseCommit',
  'checkpointCommit',
] as const satisfies readonly (keyof ReviewCheckpointInput)[];

const isBlank = (value: string): boolean => value.trim().length === 0;

/**
 * Deterministic identity for a checkpoint's binding.
 *
 * Deliberately excludes `createdAt`, `handoff`, `evidence` and `runId`: a
 * redelivered event describes the SAME checkpoint even when it arrives later,
 * is reworded, or is retried under a fresh run.
 */
export function reviewCheckpointIdentity(input: ReviewCheckpointInput): string {
  // NUL-joined so a value containing the separator cannot forge a neighbour's
  // boundary (commit + worktree are attacker-adjacent strings).
  const material = IDENTITY_FIELDS.map((field) => input[field].trim()).join('\0');
  return `rcp_${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

/** Mint a review checkpoint from its binding. Does not validate — callers gate on `canAdvanceCheckpoint`. */
export function buildReviewCheckpoint(input: ReviewCheckpointInput): ReviewCheckpoint {
  return {
    ...input,
    evidence: {
      changedFiles: [...input.evidence.changedFiles],
      commands: [...input.evidence.commands],
      testResults: [...input.evidence.testResults],
      deferredWork: [...input.evidence.deferredWork],
    },
    schemaVersion: REVIEW_CHECKPOINT_SCHEMA_VERSION,
    id: reviewCheckpointIdentity(input),
    kind: 'implementation-review',
    superseded: false,
  };
}

/**
 * Fail-closed validation. Reports EVERY problem rather than the first, so a
 * human fixing a rejected checkpoint sees the whole list in one pass.
 */
export function validateReviewCheckpoint(checkpoint: ReviewCheckpoint): ReviewCheckpointValidation {
  const errors: ReviewCheckpointValidationCode[] = [];

  if (isBlank(checkpoint.taskId)) errors.push('missing-task');
  if (isBlank(checkpoint.implementorSessionId)) errors.push('missing-session');
  if (isBlank(checkpoint.worktree)) errors.push('missing-worktree');
  if (isBlank(checkpoint.baseCommit)) errors.push('missing-base-commit');
  if (isBlank(checkpoint.checkpointCommit)) errors.push('missing-checkpoint-commit');
  if (isBlank(checkpoint.handoff)) errors.push('missing-handoff');
  if (isBlank(checkpoint.readinessTarget)) errors.push('missing-readiness-target');

  // A review reads a commit. An uncommitted worktree means the reviewer and the
  // implementor would be looking at different bytes.
  if (checkpoint.dirtyWorktree) errors.push('dirty-worktree');

  // The commit pair is the ground truth; evidence is a claim about it. If
  // nothing was committed, a changed-file list contradicts the commits.
  const nothingCommitted =
    !isBlank(checkpoint.baseCommit) && checkpoint.baseCommit.trim() === checkpoint.checkpointCommit.trim();
  if (nothingCommitted && checkpoint.evidence.changedFiles.length > 0) errors.push('inconsistent-evidence');

  if (checkpoint.schemaVersion !== REVIEW_CHECKPOINT_SCHEMA_VERSION) errors.push('unsupported-schema-version');

  return { valid: errors.length === 0, errors };
}

/**
 * The single gate on advancement. A checkpoint advances only when it is fully
 * valid AND still current — a superseded record describes work that a later
 * checkpoint has already replaced.
 */
export function canAdvanceCheckpoint(checkpoint: ReviewCheckpoint): boolean {
  if (checkpoint.superseded) return false;
  return validateReviewCheckpoint(checkpoint).valid;
}

/**
 * Collapse duplicate events to one record per identity and mark stale records
 * superseded.
 *
 * Two different things are happening here and conflating them loses data:
 * duplicates (same identity) are the SAME checkpoint delivered twice, so the
 * later delivery wins outright; supersession (same task+session, different
 * commits) is genuinely NEW work, so both records are kept and the older is
 * flagged. Dropping the older would erase the audit trail the epic is for.
 */
export function collapseReviewCheckpoints(checkpoints: readonly ReviewCheckpoint[]): ReviewCheckpoint[] {
  const byIdentity = new Map<string, ReviewCheckpoint>();
  for (const checkpoint of checkpoints) {
    const existing = byIdentity.get(checkpoint.id);
    if (!existing || checkpoint.createdAt >= existing.createdAt) byIdentity.set(checkpoint.id, checkpoint);
  }

  const deduped = [...byIdentity.values()];
  const newestPerTarget = new Map<string, number>();
  for (const checkpoint of deduped) {
    const target = `${checkpoint.taskId}\0${checkpoint.implementorSessionId}`;
    const seen = newestPerTarget.get(target);
    if (seen === undefined || checkpoint.createdAt > seen) newestPerTarget.set(target, checkpoint.createdAt);
  }

  return deduped.map((checkpoint) => {
    const target = `${checkpoint.taskId}\0${checkpoint.implementorSessionId}`;
    return { ...checkpoint, superseded: checkpoint.createdAt < (newestPerTarget.get(target) ?? checkpoint.createdAt) };
  });
}

/**
 * Classify an existing checkpoint run.
 *
 * Defaults to `context-management`, which is what keeps every pre-existing
 * compact/clear/new run behaving exactly as before: a run only becomes an
 * implementation review when a review record explicitly claims it.
 */
export function checkpointKindForRun(runId: string, checkpoints: readonly ReviewCheckpoint[]): CheckpointKind {
  return checkpoints.some((checkpoint) => checkpoint.runId === runId) ? 'implementation-review' : 'context-management';
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Parse a persisted record, forward-compatibly.
 *
 * Unknown fields from a newer writer are ignored rather than preserved, so the
 * in-memory shape stays exactly the declared type. A record whose
 * `schemaVersion` we do not understand is still RETURNED — dropping it would
 * silently delete a human's audit row — but `validateReviewCheckpoint` refuses
 * it, so it cannot advance. Returns null only for something that is not a
 * checkpoint record at all.
 */
export function parseReviewCheckpoint(raw: unknown): ReviewCheckpoint | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  if (record.kind !== 'implementation-review') return null;

  const evidence = (typeof record.evidence === 'object' && record.evidence !== null ? record.evidence : {}) as Record<
    string,
    unknown
  >;

  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : REVIEW_CHECKPOINT_SCHEMA_VERSION,
    id: record.id,
    kind: 'implementation-review',
    runId: asString(record.runId),
    taskId: asString(record.taskId),
    implementorSessionId: asString(record.implementorSessionId),
    worktree: asString(record.worktree),
    baseCommit: asString(record.baseCommit),
    checkpointCommit: asString(record.checkpointCommit),
    handoff: asString(record.handoff),
    readinessTarget: asString(record.readinessTarget),
    dirtyWorktree: record.dirtyWorktree === true,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    superseded: record.superseded === true,
    evidence: {
      changedFiles: asStringArray(evidence.changedFiles),
      commands: asStringArray(evidence.commands),
      testResults: asStringArray(evidence.testResults),
      deferredWork: asStringArray(evidence.deferredWork),
    },
  };
}
