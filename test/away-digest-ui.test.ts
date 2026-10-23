import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(join(process.cwd(), 'src/web/public/index.html'), 'utf-8');
const panelsJs = readFileSync(join(process.cwd(), 'src/web/public/panels-ui.js'), 'utf-8');
const settingsJs = readFileSync(join(process.cwd(), 'src/web/public/settings-ui.js'), 'utf-8');
const stylesCss = readFileSync(join(process.cwd(), 'src/web/public/styles.css'), 'utf-8');
const mobileCss = readFileSync(join(process.cwd(), 'src/web/public/mobile.css'), 'utf-8');

describe('away digest UI', () => {
  it('renders the server-provided effective activity detail in still-running items', () => {
    expect(panelsJs).toContain('escapeHtml(item.detail)');
    expect(panelsJs).toContain("['stillRunning', 'Still Running']");
  });
  it('exposes a header entry point and modal shell', () => {
    expect(indexHtml).toContain('onclick="app.openAwayDigest()"');
    expect(indexHtml).toContain('btn-away-digest--hidden');
    expect(indexHtml).toContain('id="appSettingsShowAwayDigest"');
    expect(indexHtml).toContain('aria-label="Open away digest"');
    expect(indexHtml).toContain('id="awayDigestModal"');
    expect(indexHtml).toContain('id="awayDigestSummary"');
    expect(indexHtml).toContain('id="awayDigestSections"');
  });

  it('offers supported range controls', () => {
    expect(indexHtml).toContain('data-away-range="since-last-visit"');
    expect(indexHtml).toContain('data-away-range="1h"');
    expect(indexHtml).toContain('data-away-range="today"');
    expect(indexHtml).toContain('data-away-range="24h"');
    expect(indexHtml).toContain('id="awayDigestCustomSince"');
    expect(indexHtml).toContain('id="awayDigestCustomUntil"');
  });

  it('fetches the aggregate endpoint and preserves since-last-visit until successful close', () => {
    expect(panelsJs).toContain('/api/away-digest');
    expect(panelsJs).toContain('codeman-away-digest-last-viewed');
    expect(panelsJs).toContain('openAwayDigest');
    expect(panelsJs).toContain('Away Digest is disabled in App Settings');
    expect(panelsJs).toContain('closeAwayDigest');
  });

  it('has desktop and mobile layout styles', () => {
    expect(stylesCss).toContain('.away-digest-modal');
    expect(stylesCss).toContain('.away-digest-summary');
    expect(stylesCss).toContain('.away-digest-item');
    expect(mobileCss).toContain('.away-digest-modal');
    expect(mobileCss).toContain('.away-digest-ranges');
  });
});

// COD-214: showAwayDigest setting (opt-in, default off)
describe('COD-214 Away Digest visibility setting', () => {
  it('header button has id="awayDigestBtn" for programmatic visibility control', () => {
    expect(indexHtml).toContain('id="awayDigestBtn"');
    expect(indexHtml).toContain('btn-away-digest');
    // Starts hidden by default; applySettings removes --hidden when the setting is enabled
    expect(indexHtml).toContain('btn-away-digest--hidden');
  });

  it('settings panel has Away Digest checkbox under Header Displays', () => {
    expect(indexHtml).toContain('appSettingsShowAwayDigest');
  });

  it('defaults showAwayDigest to false', () => {
    expect(settingsJs).toContain('settings.showAwayDigest ?? defaults.showAwayDigest ?? false');
  });

  it('reads appSettingsShowAwayDigest checkbox in loadSettings', () => {
    expect(settingsJs).toContain("getElementById('appSettingsShowAwayDigest')");
  });

  it('includes showAwayDigest in saveSettings payload', () => {
    expect(settingsJs).toMatch(/showAwayDigest\s*:.*getElementById\('appSettingsShowAwayDigest'\)/);
  });

  it('strips showAwayDigest from the server PUT (client-only setting)', () => {
    // Must be destructured out before the serverSettings spread
    expect(settingsJs).toMatch(/showAwayDigest\s*:\s*_s?a/);
  });

  it('toggles btn-away-digest--hidden in applySettings', () => {
    expect(settingsJs).toContain('btn-away-digest--hidden');
    expect(settingsJs).toContain('awayDigestBtn');
  });

  it('has CSS to hide the away digest button', () => {
    expect(stylesCss).toMatch(/\.btn-away-digest--hidden\s*\{[^}]*display\s*:\s*none/);
  });

  it('guards openAwayDigest when showAwayDigest is disabled', () => {
    // Function contains both the method name and the settings check
    expect(panelsJs).toContain('openAwayDigest');
    expect(panelsJs).toContain('settings.showAwayDigest');
    expect(panelsJs).toContain('Away Digest is disabled in App Settings');
  });
});
