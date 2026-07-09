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

  it('drops box-drawing dividers from the last response and treats worked-for lines as status', () => {
    const transcript = `
────────────────────────────────────────────────────────────────────────

• The launcher supports CODEMAN_APP_DIR, so I can deploy this exact worktree without merging it back first.

────────────────────────────────────────────────────────────────────────

• Deployed.

The local Codeman service is now running from the worktree at app/.worktrees/cod-215-response-viewer on
commit 8bbcf77bafbdbf01a34653386c256b685898ad06.

Verified:

- process pid: 2708947
- HTTPS health: https://127.0.0.1:3000/ returned 401 as expected

One detail: I had to restart it outside the sandbox because the sandboxed launch path could not see tmux.

─ Worked for 1m 51s ───────────────────────────────────────────────────

› what are these lines in the middle column?
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toContain('• Deployed.');
    expect(getLastTranscriptResponse(blocks)).not.toContain('────────────────');
    expect(getLastTranscriptResponse(blocks)).not.toContain('Worked for 1m 51s');
    expect(blocks.some((block) => block.kind === 'status' && block.text === 'Worked for 1m 51s')).toBe(true);
  });
});
