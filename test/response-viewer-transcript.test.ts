import { describe, expect, it } from 'vitest';
import { getLastTranscriptResponse, parseExternalCliTranscript } from '../src/web/response-viewer-transcript.js';

describe('response viewer transcript parser', () => {
  it('extracts structured COD transcript blocks and keeps labeled status/tool entries', () => {
    const transcript = `
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.143.0)                           │
│ model:     gpt-5.4 medium   /model to change         │
│ directory: /mnt/c/Users/aakhter/.../kb              │
╰──────────────────────────────────────────────────────╯

Tip: Use /side to start a side conversation in a temporary fork without polluting the main thread.

› i need to create a naming recommendation for project helix

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Subject: Naming Recommendation for Project Helix

The product helps customers move virtual machine workloads between hypervisors while keeping operations
stable. It improves visibility into application dependencies, supports pre-migration validation, and reduces
the risk
and effort involved in moving workloads.

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(blocks.map((block) => block.kind)).toEqual([
      'status',
      'prompt',
      'status',
      'tool',
      'response',
      'prompt',
      'status',
    ]);
    expect(blocks[0]?.label).toBe('Status');
    expect(blocks[3]?.label).toBe('Tool');
    expect(blocks[4]?.text).toContain('reduces the risk and effort involved');
    expect(blocks[4]?.text).not.toContain('reduces\nthe risk');
  });

  it('returns the most recent completed response when the last block is a new prompt', () => {
    const transcript = `
› say again

Final polished answer
With two lines

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toBe('Final polished answer\nWith two lines');
  });
});
