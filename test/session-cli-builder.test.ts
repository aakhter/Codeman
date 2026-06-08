/**
 * @fileoverview Tests for CLI environment builders.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { buildMuxAttachEnv } from '../src/session-cli-builder.js';

describe('buildMuxAttachEnv', () => {
  it('does not pass an inherited tmux context into tmux attach clients', () => {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX = '/tmp/tmux-1000/codeman,1169416,9';
    process.env.TMUX_PANE = '%9';

    try {
      const env = buildMuxAttachEnv();

      expect(env.TMUX).toBeUndefined();
      expect(env.TMUX_PANE).toBeUndefined();
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
    }
  });
});
