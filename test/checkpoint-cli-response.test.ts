/** @fileoverview Defensive checkpoint CLI response interpretation (COD-240). */
import { describe, expect, it } from 'vitest';
import {
  checkpointWaitRequestTimeoutMs,
  evaluateCheckpointWait,
  interpretCheckpointResponse,
  shouldRetryCheckpointWaitRequest,
} from '../src/cli.js';

describe('interpretCheckpointResponse', () => {
  it.each([
    [null, 'empty response'],
    ['not json', 'malformed response'],
    [{ success: true, data: null }, 'malformed success response'],
    [{ success: true, data: {} }, 'malformed success response'],
    [{ success: false, error: 'hook refused' }, 'hook refused'],
  ])('rejects %j explicitly', (body, message) => {
    expect(interpretCheckpointResponse(body)).toEqual({ ok: false, error: expect.stringContaining(message) });
  });

  it('returns the server refusal reason without claiming success', () => {
    expect(
      interpretCheckpointResponse({
        success: true,
        data: { checkpoint: { triggered: false, reason: 'busy' } },
      })
    ).toEqual({ ok: true, triggered: false, reason: 'busy' });
  });

  it('accepts only a well-formed requested response with its stable run id', () => {
    expect(
      interpretCheckpointResponse({ success: true, data: { checkpoint: { triggered: true, runId: 'run-262' } } })
    ).toEqual({
      ok: true,
      triggered: true,
      runId: 'run-262',
    });
    expect(interpretCheckpointResponse({ success: true, data: { checkpoint: { triggered: true } } })).toEqual({
      ok: false,
      error: expect.stringContaining('run ID'),
    });
  });
});

describe('evaluateCheckpointWait', () => {
  it('fails a bounded wait when the requested run remains missing or was evicted', () => {
    expect(evaluateCheckpointWait({}, 'missing-run', 0, 5_000, 20)).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('missing'),
    });
  });

  it('keeps waiting for an exact running run beyond 120 seconds but enforces the final lifecycle bound', () => {
    const state = {
      checkpointRuns: {
        'running-run': { runId: 'running-run', status: 'running' },
      },
    };
    expect(evaluateCheckpointWait(state, 'running-run', 0, 130_000, 0)).toEqual({
      kind: 'waiting',
      missing: false,
    });
    expect(evaluateCheckpointWait(state, 'running-run', 0, 240_001, 0)).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('timed out'),
    });
  });
});

describe('checkpoint wait transport policy', () => {
  it('caps each GET by the remaining lifecycle deadline', () => {
    expect(checkpointWaitRequestTimeoutMs(1_000, 1_000)).toBe(5_000);
    expect(checkpointWaitRequestTimeoutMs(1_000, 239_000)).toBe(2_000);
    expect(checkpointWaitRequestTimeoutMs(1_000, 241_000)).toBe(0);
  });

  it('retries only a bounded number of transient transport failures', () => {
    expect(shouldRetryCheckpointWaitRequest(0, 1, 1_000)).toBe(true);
    expect(shouldRetryCheckpointWaitRequest(0, 5, 1_000)).toBe(false);
    expect(shouldRetryCheckpointWaitRequest(0, 1, 240_001)).toBe(false);
  });
});
