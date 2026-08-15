/**
 * COD-265 — implementation-review checkpoint contract.
 *
 * The epic's foundation story: bind a task/session/worktree/commit pair into ONE
 * validated, idempotent checkpoint identity that the Orchestrator can persist and
 * reload, without introducing a second checkpoint state machine alongside the
 * existing `session-auto-ops` compact/clear/new engine.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { DEFAULT_ORCHESTRATOR_CONFIG, createInitialOrchestratorStats } from '../src/types/orchestrator.js';
import {
  REVIEW_CHECKPOINT_SCHEMA_VERSION,
  buildReviewCheckpoint,
  canAdvanceCheckpoint,
  checkpointKindForRun,
  collapseReviewCheckpoints,
  parseReviewCheckpoint,
  reviewCheckpointIdentity,
  validateReviewCheckpoint,
  type ReviewCheckpoint,
  type ReviewCheckpointInput,
} from '../src/orchestrator-review-checkpoint.js';

const baseInput: ReviewCheckpointInput = {
  runId: 'run-1',
  taskId: 'phase-1-task-2',
  implementorSessionId: 'sess-abc',
  worktree: '/home/u/work/repo',
  baseCommit: 'a'.repeat(40),
  checkpointCommit: 'b'.repeat(40),
  handoff: 'Implemented the rate limiter; see evidence.',
  readinessTarget: 'phase-1-verified',
  dirtyWorktree: false,
  createdAt: 1_700_000_000_000,
  evidence: {
    changedFiles: ['src/middleware/rate-limiter.ts'],
    commands: ['npm test -- test/rate-limiter.test.ts'],
    testResults: ['12 passed'],
    deferredWork: [],
  },
};

describe('COD-265 review checkpoint identity', () => {
  it('derives a deterministic identity from the binding', () => {
    const a = reviewCheckpointIdentity(baseInput);
    const b = reviewCheckpointIdentity({ ...baseInput, createdAt: 999, handoff: 'reworded' });
    // Identity is the BINDING (task+session+worktree+commits), not incidental
    // fields — otherwise a duplicate event with a new timestamp mints a new id.
    expect(a).toBe(b);
    expect(a).toMatch(/^rcp_[0-9a-f]{16}$/);
  });

  it('changes identity when the checkpoint commit changes', () => {
    const a = reviewCheckpointIdentity(baseInput);
    const b = reviewCheckpointIdentity({ ...baseInput, checkpointCommit: 'c'.repeat(40) });
    expect(a).not.toBe(b);
  });

  it('collapses duplicate checkpoint events to one identity, keeping the latest', () => {
    const first = buildReviewCheckpoint(baseInput);
    const duplicate = buildReviewCheckpoint({ ...baseInput, createdAt: baseInput.createdAt + 5_000 });
    const other = buildReviewCheckpoint({ ...baseInput, taskId: 'phase-1-task-3' });

    const collapsed = collapseReviewCheckpoints([first, duplicate, other]);

    expect(collapsed).toHaveLength(2);
    const kept = collapsed.find((c) => c.id === first.id);
    expect(kept?.createdAt).toBe(baseInput.createdAt + 5_000);
  });

  it('marks an older checkpoint superseded by a newer one for the same task and session', () => {
    const older = buildReviewCheckpoint(baseInput);
    const newer = buildReviewCheckpoint({
      ...baseInput,
      checkpointCommit: 'c'.repeat(40),
      createdAt: baseInput.createdAt + 60_000,
    });

    const collapsed = collapseReviewCheckpoints([older, newer]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((c) => c.id === older.id)?.superseded).toBe(true);
    expect(collapsed.find((c) => c.id === newer.id)?.superseded).toBe(false);
  });
});

describe('COD-265 review checkpoint validation (fail-closed)', () => {
  it('accepts a complete checkpoint', () => {
    const result = validateReviewCheckpoint(buildReviewCheckpoint(baseInput));
    expect(result).toEqual({ valid: true, errors: [] });
    expect(canAdvanceCheckpoint(buildReviewCheckpoint(baseInput))).toBe(true);
  });

  it.each([
    ['checkpointCommit', 'missing-checkpoint-commit'],
    ['baseCommit', 'missing-base-commit'],
    ['handoff', 'missing-handoff'],
    ['readinessTarget', 'missing-readiness-target'],
    ['taskId', 'missing-task'],
    ['implementorSessionId', 'missing-session'],
    ['worktree', 'missing-worktree'],
  ] as const)('rejects a checkpoint with an empty %s', (field, code) => {
    const checkpoint = buildReviewCheckpoint({ ...baseInput, [field]: '   ' });
    const result = validateReviewCheckpoint(checkpoint);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(code);
    expect(canAdvanceCheckpoint(checkpoint)).toBe(false);
  });

  it('rejects a dirty worktree', () => {
    const checkpoint = buildReviewCheckpoint({ ...baseInput, dirtyWorktree: true });
    expect(validateReviewCheckpoint(checkpoint).errors).toContain('dirty-worktree');
    expect(canAdvanceCheckpoint(checkpoint)).toBe(false);
  });

  it('rejects evidence claiming changed files when no commit was made', () => {
    // base === checkpoint means nothing was committed, so "changed files" is a
    // claim the commit pair contradicts. An evidence gap must not advance.
    const checkpoint = buildReviewCheckpoint({ ...baseInput, checkpointCommit: baseInput.baseCommit });
    expect(validateReviewCheckpoint(checkpoint).errors).toContain('inconsistent-evidence');
    expect(canAdvanceCheckpoint(checkpoint)).toBe(false);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const checkpoint = buildReviewCheckpoint({ ...baseInput, handoff: '', worktree: '', dirtyWorktree: true });
    expect(validateReviewCheckpoint(checkpoint).errors).toEqual(
      expect.arrayContaining(['missing-handoff', 'missing-worktree', 'dirty-worktree'])
    );
  });

  it('refuses to advance a superseded checkpoint even when otherwise valid', () => {
    const checkpoint: ReviewCheckpoint = { ...buildReviewCheckpoint(baseInput), superseded: true };
    expect(canAdvanceCheckpoint(checkpoint)).toBe(false);
  });
});

describe('COD-265 versioned persistence', () => {
  it('round-trips through JSON so a checkpoint survives a restart', () => {
    const checkpoint = buildReviewCheckpoint(baseInput);
    const reloaded = parseReviewCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    expect(reloaded).toEqual(checkpoint);
    expect(checkpoint.schemaVersion).toBe(REVIEW_CHECKPOINT_SCHEMA_VERSION);
  });

  it('ignores unknown fields from a newer writer without dropping the record', () => {
    const raw = { ...buildReviewCheckpoint(baseInput), someFutureField: 'ignored' };
    const parsed = parseReviewCheckpoint(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('someFutureField');
  });

  it('keeps a future schema version but refuses to advance it', () => {
    // Fail closed: a record we cannot fully understand must not be silently
    // dropped (that loses the human's audit trail) nor acted upon.
    const raw = { ...buildReviewCheckpoint(baseInput), schemaVersion: REVIEW_CHECKPOINT_SCHEMA_VERSION + 1 };
    const parsed = parseReviewCheckpoint(raw);
    expect(parsed).not.toBeNull();
    expect(validateReviewCheckpoint(parsed!).errors).toContain('unsupported-schema-version');
    expect(canAdvanceCheckpoint(parsed!)).toBe(false);
  });

  it.each([null, undefined, 42, 'nope', [], {}])('returns null for the non-record %s', (raw) => {
    expect(parseReviewCheckpoint(raw)).toBeNull();
  });
});

describe('COD-265 survives a restart through the real StateStore', () => {
  // ⚠️ Pre-existing bug found while writing these: `buildPartialJson()` writes a
  // fixed allowlist of top-level keys and `orchestrator` was not on it, so
  // orchestrator state was held in memory and silently dropped on every save.
  // The review-checkpoint restart criterion cannot hold without this.
  it('writes the orchestrator key to disk at all', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'codeman-cod265-'));
    const file = join(dir, 'state.json');
    try {
      const store = new StateStore(file);
      store.setOrchestratorState({
        state: 'executing',
        plan: null,
        currentPhaseIndex: 2,
        startedAt: 1,
        completedAt: null,
        config: DEFAULT_ORCHESTRATOR_CONFIG,
        stats: createInitialOrchestratorStats(),
      });
      await store.saveNowAsync();

      const onDisk = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
      expect(onDisk).toHaveProperty('orchestrator');
      expect((onDisk.orchestrator as { currentPhaseIndex: number }).currentPhaseIndex).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits each top-level key exactly once', async () => {
    // `sessionOrder` was pushed twice, producing a duplicate JSON key. Harmless
    // to JSON.parse (last wins) but it doubles the bytes and hides real drift.
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'codeman-cod265-'));
    const file = join(dir, 'state.json');
    try {
      const store = new StateStore(file);
      store.setSessionOrder(['a', 'b']);
      await store.saveNowAsync();

      const raw = await fs.readFile(file, 'utf-8');
      expect(raw.match(/"sessionOrder":/g)).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reloads persisted review checkpoints from a fresh store on the same file', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'codeman-cod265-'));
    const file = join(dir, 'state.json');
    try {
      const checkpoint = buildReviewCheckpoint(baseInput);
      const store = new StateStore(file);
      store.setOrchestratorState({
        state: 'verifying',
        plan: null,
        currentPhaseIndex: 0,
        startedAt: baseInput.createdAt,
        completedAt: null,
        config: DEFAULT_ORCHESTRATOR_CONFIG,
        stats: createInitialOrchestratorStats(),
        reviewCheckpoints: [checkpoint],
      });
      await store.saveNowAsync();

      // A genuinely separate store instance reading the same file is the restart.
      const reloaded = new StateStore(file).getOrchestratorState();

      expect(reloaded?.reviewCheckpoints).toEqual([checkpoint]);
      const parsed = parseReviewCheckpoint(reloaded!.reviewCheckpoints![0]);
      expect(canAdvanceCheckpoint(parsed!)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('COD-265 no second checkpoint engine', () => {
  it('classifies a run with no review checkpoint as context management', () => {
    // The existing /compact, /clear and /new runs in session-auto-ops keep their
    // own runIds and must stay untouched by this contract.
    expect(checkpointKindForRun('run-unknown', [])).toBe('context-management');
    expect(checkpointKindForRun('run-unknown', [buildReviewCheckpoint(baseInput)])).toBe('context-management');
  });

  it('classifies a run bound to a review checkpoint as implementation review', () => {
    expect(checkpointKindForRun('run-1', [buildReviewCheckpoint(baseInput)])).toBe('implementation-review');
  });
});
