import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectCodexContract } from './codex-contract-spike.mjs';
const fixture = readFileSync(new URL('../../test/fixtures/openclaw/codex-0.160.1.jsonl', import.meta.url), 'utf8');
const expected = {
  conversationId: '01a116ff-5757-7623-82d9-49b6eb735d99',
  originator: 'codeman_cod487-spike',
  prompt: 'Reply with exactly COD487_SPIKE_OK. Do not use any tools.',
};
test('observed native format proves acceptance and matching final completion', () => {
  assert.equal(inspectCodexContract(fixture, expected).completed, true);
});
test('commentary, foreign completion, missing acceptance and partial completion never prove success', () => {
  assert.equal(inspectCodexContract(fixture.replace('final_answer', 'commentary'), expected).completed, false);
  const rows = fixture.trim().split('\n').map(JSON.parse);
  const wrong = structuredClone(rows);
  wrong.at(-1).payload.turn_id = 'other';
  assert.equal(inspectCodexContract(wrong.map(JSON.stringify).join('\n') + '\n', expected).completed, false);
  assert.equal(
    inspectCodexContract(rows.slice(0, -1).map(JSON.stringify).join('\n') + '\n{"type":', expected).completed,
    false
  );
  assert.equal(
    inspectCodexContract(fixture, { ...expected, prompt: 'same text from another request' }).supported,
    false
  );
  assert.equal(inspectCodexContract(fixture, { ...expected, conversationId: 'another-thread' }).supported, false);
});
