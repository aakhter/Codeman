/**
 * Headroom attribution panel contract (COD-254).
 * Ensures proxy-wide counters, managed-session snapshots, and their distinct
 * applicability are not collapsed into a single implied scope. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

function loadHeadroomHarness(response: unknown) {
  const elements: Record<string, { style: Record<string, string>; textContent: string; innerHTML: string }> = {};
  for (const id of [
    'appSettingsHeadroomDot',
    'appSettingsHeadroomHealth',
    'appSettingsHeadroomSavings',
    'appSettingsHeadroomSessions',
  ]) {
    elements[id] = { style: {}, textContent: '', innerHTML: '' };
  }
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    document: { getElementById: (id: string) => elements[id] ?? null },
    fetch: async () => ({ json: async () => response }),
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  return { app: new (CodemanApp as any)(), elements };
}

describe('Headroom attribution panel', () => {
  it('labels aggregate proxy metrics and managed routing snapshots as different scopes', () => {
    expect(html).toContain('Proxy-wide · all proxy clients');
    expect(html).toContain('Managed-session launch / respawn snapshots');
    expect(settingsUi).toContain('Agent usage');
    expect(settingsUi).toContain('Providers');
    expect(settingsUi).toContain('snapshot');
  });

  it('explains when proxy traffic cannot be attributed to the listed managed sessions', () => {
    expect(html).toContain('Proxy activity is not attributable to these managed-session snapshots');
  });

  it('clarifies Codex config reconciliation versus a running session snapshot', () => {
    expect(html).toContain('shared Codex config is reconciled immediately');
    expect(html).toContain("running session's routing snapshot changes on its next respawn");
  });

  it('renders proxy attribution separately from a legacy direct-session snapshot', async () => {
    const { app, elements } = loadHeadroomHarness({
      success: true,
      data: {
        enabled: true,
        healthy: true,
        version: '0.25.0',
        latencyMs: 12,
        stats: {
          tokensSaved: 99,
          compressedPct: 50,
          compressed: 4,
          requests: 8,
          costSavedUsd: 1,
          savingsPct: 25,
          cacheSavedUsd: 0,
          bestPct: 60,
          attribution: {
            agents: [{ agent: 'claude-code', label: 'Claude Code', requests: 8, tokensSaved: 99 }],
            providers: { anthropic: 8 },
          },
        },
        routedSessions: [{ name: 'Direct Codex', mode: 'codex', routed: false, routedAt: null }],
      },
    });

    await app._refreshHeadroomStatus();

    expect(elements.appSettingsHeadroomSavings.innerHTML).toContain('Claude Code: 8 requests');
    expect(elements.appSettingsHeadroomSavings.innerHTML).toContain('anthropic: 8');
    expect(elements.appSettingsHeadroomSessions.innerHTML).toContain('Direct Codex');
    expect(elements.appSettingsHeadroomSessions.innerHTML).toContain('direct');
    expect(elements.appSettingsHeadroomSessions.innerHTML).toContain('snapshot recorded before timestamps');
    expect(elements.appSettingsHeadroomSessions.innerHTML).not.toContain('1970');
  });
});
