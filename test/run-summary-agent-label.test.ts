/**
 * @fileoverview COD-473: the Summary timeline's idle/working rows name the session's
 * own CLI (registry `label`), not a hardcoded 'Claude'.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RunSummaryTracker } from '../src/run-summary.js';
import { getCli } from '../src/config/cli-registry/registry.js';

const trackers: RunSummaryTracker[] = [];

function titlesFor(mode: string, agentLabel: string | undefined): string[] {
  const tracker = new RunSummaryTracker('s1', 'w1-test');
  trackers.push(tracker);
  tracker.recordSessionStarted(mode, '/tmp', agentLabel);
  tracker.recordWorking();
  tracker.recordIdle();
  return tracker
    .getSummary()
    .events.filter((e) => e.type === 'working_detected' || e.type === 'idle_detected')
    .map((e) => e.title);
}

afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
});

describe('RunSummaryTracker agent label', () => {
  it('names codex for a codex session', () => {
    expect(titlesFor('codex', getCli('codex')?.label)).toEqual(['Codex is working', 'Codex is idle']);
  });

  it('names Claude Code for a claude session', () => {
    expect(titlesFor('claude', getCli('claude')?.label)).toEqual(['Claude Code is working', 'Claude Code is idle']);
  });

  it('falls back to a neutral label when the mode has no registry entry', () => {
    expect(titlesFor('nope', getCli('nope')?.label)).toEqual(['Agent is working', 'Agent is idle']);
  });
});
