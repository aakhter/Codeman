/**
 * COD-122 — Monitor "Tmux Sessions" rows must use the TAB NAME as the primary
 * (L1) label, and surface the tmux session name + agent (Claude/Codex) session id
 * as secondary metadata.
 *
 * `resolveMonitorRowLabels` is the pure label-selection policy behind the row
 * renderer (`_renderMuxSessionsImmediate` in panels-ui.js). It is exposed on
 * `window.CodemanMonitorLabels` and tested here in a plain node VM context (no
 * jsdom — jsdom env setup is broken on some hosts), mirroring the
 * `CodemanTabOverflow` test harness in test/tab-overflow.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type RowLabels = {
  primary: string;
  secondaries: { kind: 'tmux' | 'agent'; label: string }[];
};

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanMonitorLabels: { resolveMonitorRowLabels: (i: unknown) => RowLabels } })
    .CodemanMonitorLabels;
}

describe('COD-122 Monitor row label policy', () => {
  it('uses the tab name as the primary label and exposes tmux + agent as secondaries', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({
      tabName: 'my work',
      muxName: 'codeman-1fac7304',
      agentSessionId: 'abc-123-claude',
      sessionId: 's-real',
    });
    expect(out.primary).toBe('my work');
    expect(out.secondaries).toEqual([
      { kind: 'tmux', label: 'codeman-1fac7304' },
      { kind: 'agent', label: 'abc-123-claude' },
    ]);
  });

  it('orders tmux before the agent identifier', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({
      tabName: 'tab',
      muxName: 'codeman-x',
      agentSessionId: 'agent-y',
      sessionId: 's1',
    });
    expect(out.secondaries.map((s) => s.kind)).toEqual(['tmux', 'agent']);
  });

  it('falls back to the stored mux name, then the tmux name, when no tab name is set', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    expect(resolveMonitorRowLabels({ storedName: 'stored', muxName: 'codeman-x', sessionId: 's1' }).primary).toBe(
      'stored'
    );
    expect(resolveMonitorRowLabels({ muxName: 'codeman-x', sessionId: 's1' }).primary).toBe('codeman-x');
  });

  it('does not duplicate the tmux name as a secondary when it is already the primary fallback', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({ muxName: 'codeman-x', sessionId: 's1' });
    expect(out.primary).toBe('codeman-x');
    expect(out.secondaries).toEqual([]);
  });

  it('omits the agent identifier when it is unknown (missing) — graceful degradation', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({ tabName: 'tab', muxName: 'codeman-x', sessionId: 's1' });
    expect(out.secondaries).toEqual([{ kind: 'tmux', label: 'codeman-x' }]);
  });

  it('treats an agent id equal to the codeman sessionId as a not-yet-known placeholder and omits it', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({
      tabName: 'tab',
      muxName: 'codeman-x',
      agentSessionId: 's-self',
      sessionId: 's-self',
    });
    expect(out.secondaries).toEqual([{ kind: 'tmux', label: 'codeman-x' }]);
  });

  it('always yields a non-empty primary even when everything is missing', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    expect(resolveMonitorRowLabels({}).primary).toBeTruthy();
    expect(resolveMonitorRowLabels(null).primary).toBeTruthy();
  });

  it('trims whitespace on all identifiers', () => {
    const { resolveMonitorRowLabels } = loadHelper();
    const out = resolveMonitorRowLabels({
      tabName: '  spaced  ',
      muxName: '  codeman-x  ',
      agentSessionId: '  agent-z  ',
      sessionId: 's1',
    });
    expect(out.primary).toBe('spaced');
    expect(out.secondaries).toEqual([
      { kind: 'tmux', label: 'codeman-x' },
      { kind: 'agent', label: 'agent-z' },
    ]);
  });
});
