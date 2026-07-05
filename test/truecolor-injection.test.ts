/**
 * @fileoverview Tests for the COLORTERM=truecolor opt-in knob (COD-75).
 *
 * COLORTERM is unset for Claude sessions by default to avoid
 * tmux→PTY→xterm.js color glitches. The `truecolorEnabled` app setting lets a
 * user opt Claude sessions back into 24-bit truecolor. Both spawn paths must
 * agree:
 *   - the tmux path  → `buildEnvExports()` in tmux-manager
 *   - the direct PTY → `buildClaudeEnv()`/`buildMuxAttachEnv()` in session-cli-builder
 *
 * Bubble Tea/Ink TUIs (OpenCode, Codex, Gemini) always get
 * `export COLORTERM=truecolor` regardless of the toggle.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { buildClaudeEnv, buildMuxAttachEnv } from '../src/session-cli-builder.js';
import type { SessionMode } from '../src/types.js';

/** Reach the private buildEnvExports for assertion. */
function envExports(mode: SessionMode, truecolorEnabled?: boolean): string[] {
  const manager = new TmuxManager();
  return (
    manager as unknown as {
      buildEnvExports(sessionId: string, muxName: string, mode: SessionMode, truecolorEnabled?: boolean): string[];
    }
  ).buildEnvExports('session-1', 'codeman-abc12345', mode, truecolorEnabled);
}

describe('buildEnvExports COLORTERM (tmux path)', () => {
  it('Claude + truecolorEnabled:true → exports COLORTERM=truecolor', () => {
    const exports = envExports('claude', true);
    expect(exports).toContain('export COLORTERM=truecolor');
    expect(exports).not.toContain('unset COLORTERM');
  });

  it('Claude + truecolorEnabled:false (default) → unsets COLORTERM', () => {
    const exports = envExports('claude', false);
    expect(exports).toContain('unset COLORTERM');
    expect(exports).not.toContain('export COLORTERM=truecolor');
  });

  it('Claude + toggle omitted → unsets COLORTERM (default behavior)', () => {
    const exports = envExports('claude');
    expect(exports).toContain('unset COLORTERM');
    expect(exports).not.toContain('export COLORTERM=truecolor');
  });

  it('Codex → exports COLORTERM=truecolor regardless of toggle', () => {
    expect(envExports('codex', false)).toContain('export COLORTERM=truecolor');
    expect(envExports('codex', true)).toContain('export COLORTERM=truecolor');
    expect(envExports('codex', false)).not.toContain('unset COLORTERM');
  });

  it('COD-210: OpenCode → exports COLORTERM=truecolor regardless of toggle', () => {
    expect(envExports('opencode', false)).toContain('export COLORTERM=truecolor');
    expect(envExports('opencode', true)).toContain('export COLORTERM=truecolor');
    expect(envExports('opencode', false)).not.toContain('unset COLORTERM');
  });
});

describe('buildClaudeEnv COLORTERM (direct PTY path)', () => {
  it('truecolorEnabled:true → COLORTERM=truecolor', () => {
    expect(buildClaudeEnv('sid-1', true).COLORTERM).toBe('truecolor');
  });

  it('truecolorEnabled:false (default) → COLORTERM undefined (unset)', () => {
    expect(buildClaudeEnv('sid-1', false).COLORTERM).toBeUndefined();
  });

  it('toggle omitted → COLORTERM undefined (default behavior)', () => {
    expect(buildClaudeEnv('sid-1').COLORTERM).toBeUndefined();
  });
});

describe('buildMuxAttachEnv COLORTERM (direct PTY path)', () => {
  it('truecolorEnabled:true → COLORTERM=truecolor', () => {
    expect(buildMuxAttachEnv(true).COLORTERM).toBe('truecolor');
  });

  it('truecolorEnabled:false (default) → COLORTERM undefined (unset)', () => {
    expect(buildMuxAttachEnv(false).COLORTERM).toBeUndefined();
  });

  it('toggle omitted → COLORTERM undefined (default behavior)', () => {
    expect(buildMuxAttachEnv().COLORTERM).toBeUndefined();
  });
});
