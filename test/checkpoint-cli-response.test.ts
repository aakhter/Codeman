/** @fileoverview Defensive checkpoint CLI response interpretation (COD-240). */
import { describe, expect, it } from 'vitest';
import { interpretCheckpointResponse } from '../src/cli.js';

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

  it('accepts only a well-formed requested response', () => {
    expect(interpretCheckpointResponse({ success: true, data: { checkpoint: { triggered: true } } })).toEqual({
      ok: true,
      triggered: true,
    });
  });
});
