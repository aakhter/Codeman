/**
 * @fileoverview COD-257 regressions for the persistent Agent Checkpoint default.
 *
 * The app setting is server-authoritative; sessions receive its resolved value
 * only at creation time and retain the existing compact + clear mode defaults.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { CheckpointSchema, SettingsUpdateSchema } from '../src/web/schemas.js';

describe('COD-257 checkpoint default', () => {
  it('initializes a new session from an explicit checkpoint default without changing allowed modes', () => {
    const enabled = new Session({ workingDir: '/tmp', checkpointEnabled: true });
    const disabled = new Session({ workingDir: '/tmp', checkpointEnabled: false });

    expect(enabled.checkpointEnabled).toBe(true);
    expect(disabled.checkpointEnabled).toBe(false);
    expect(enabled.checkpointModes).toEqual(['compact', 'clear', 'new']);
    expect(disabled.checkpointModes).toEqual(['compact', 'clear', 'new']);
  });

  it('accepts only a boolean checkpoint default in settings updates', () => {
    expect(SettingsUpdateSchema.safeParse({ checkpointDefaultEnabled: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ checkpointDefaultEnabled: false }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ checkpointDefaultEnabled: 'true' }).success).toBe(false);
  });

  it('accepts new in the checkpoint configuration schema', () => {
    expect(CheckpointSchema.safeParse({ enabled: true, modes: ['compact', 'clear', 'new'] }).success).toBe(true);
  });

  it('renders clear and screen-preserving new without checkpoint /init claims', () => {
    const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
    // Anchor on the ROW, not the input: the settings-rail migration puts the
    // explanatory copy in .set-row-text, which precedes the control, so slicing
    // forward from the input id would start past the very text this asserts on.
    const checkpointStart = html.indexOf('data-search="agent checkpoint');
    const checkpointEnd = html.indexOf('File Watching', checkpointStart);
    const checkpointUi = html.slice(checkpointStart, checkpointEnd);
    expect(checkpointUi).toContain('modalCheckpointModeNew');
    expect(checkpointUi).toContain('preserving the display');
    expect(checkpointUi).not.toContain('/init');
    expect(readFileSync(new URL('../src/session-auto-ops.ts', import.meta.url), 'utf8')).not.toMatch(
      /CheckpointStep[^\n]*init/
    );
  });

  it('uses a server resolver with an upgrade-safe enabled default for every web session creator', () => {
    const configPort = readFileSync(new URL('../src/web/ports/config-port.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const sessionRoutes = readFileSync(new URL('../src/web/routes/session-routes.ts', import.meta.url), 'utf8');
    const ralphRoutes = readFileSync(new URL('../src/web/routes/ralph-routes.ts', import.meta.url), 'utf8');
    const planRoutes = readFileSync(new URL('../src/web/routes/plan-routes.ts', import.meta.url), 'utf8');
    const systemRoutes = readFileSync(new URL('../src/web/routes/system-routes.ts', import.meta.url), 'utf8');
    const settingsUi = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf8');
    const cronService = readFileSync(new URL('../src/cron/cron-service.ts', import.meta.url), 'utf8');
    const planOrchestrator = readFileSync(new URL('../src/plan-orchestrator.ts', import.meta.url), 'utf8');
    const sessionManager = readFileSync(new URL('../src/session-manager.ts', import.meta.url), 'utf8');

    expect(configPort).toContain('getCheckpointDefaultEnabled(): Promise<boolean>');
    expect(server).toContain('return settings.checkpointDefaultEnabled !== false;');
    // GET /api/settings is a plain read (it must never write), so the absent-key
    // default is resolved by the client when it merges server settings. The
    // behaviour is pinned in settings-authoritative-gate.test.ts.
    expect(systemRoutes).toContain("return readJsonConfig(SETTINGS_PATH, 'settings', {});");
    expect(settingsUi).toContain(
      "if (!('checkpointDefaultEnabled' in appSettings)) merged.checkpointDefaultEnabled = true;"
    );
    expect(sessionRoutes.match(/getCheckpointDefaultEnabled\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(ralphRoutes).toContain('checkpointEnabled: await ctx.getCheckpointDefaultEnabled()');
    expect(planRoutes).toContain('checkpointEnabled: await ctx.getCheckpointDefaultEnabled()');
    expect(cronService).toContain('const checkpointEnabled = await this.deps.getCheckpointDefaultEnabled()');
    expect(planOrchestrator).toContain('checkpointEnabled: this.checkpointEnabled');
    expect(sessionManager).toContain("dataPath('settings.json')");
    expect(sessionManager).toContain('checkpointEnabled: await this.getCheckpointDefaultEnabled()');
  });

  it('keeps restored sessions on their saved checkpoint value rather than the app default', () => {
    const restored = new Session({ workingDir: '/tmp', checkpointEnabled: true });
    restored.restoreCheckpoint(false, ['clear']);

    expect(restored.checkpointEnabled).toBe(false);
    expect(restored.checkpointModes).toEqual(['clear']);
  });

  it('round-trips an upgrade-safe Automation switch through server-synchronized settings', () => {
    const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf8');

    expect(html).toContain('Agent Checkpoint for new sessions');
    expect(html).toContain('appSettingsCheckpointDefault');
    expect(ui).toContain('settings.checkpointDefaultEnabled ?? defaults.checkpointDefaultEnabled ?? true');
    expect(ui).toContain("checkpointDefaultEnabled: document.getElementById('appSettingsCheckpointDefault').checked");
  });
});
