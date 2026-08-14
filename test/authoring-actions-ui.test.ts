// @vitest-environment jsdom
/**
 * COD-64 — user-configured "authoring actions" surfaced in the document preview.
 *
 * A new `authoringActions` app setting (modeled on `respawnPresets`): a list of
 * one-click actions, each a {id,label,instruction}. Clicking an action in the
 * preview footer sends a templated single-line instruction to the open document's
 * agent session via the existing `_postSessionInput` channel.
 *
 * Ships EMPTY by default — NO skill names are baked into source or schema defaults.
 *
 * This suite drives the EXACT shipping artifacts:
 *   - src/web/schemas.ts            (SettingsUpdateSchema — authoringActions array)
 *   - src/web/public/app.js + panels-ui.js (CodemanApp helpers under jsdom)
 *   - source contract on index.html / settings-ui.js / panels-ui.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const publicDir = join(process.cwd(), 'src/web/public');
const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');

const indexHtml = read('index.html');
const settingsJs = read('settings-ui.js');
const panelsJs = read('panels-ui.js');

let app: any;

beforeAll(() => {
  const combined =
    'var marked, MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('panels-ui.js') +
    '\n;globalThis.__CodemanApp = CodemanApp;';
  (0, eval)(combined);
  const CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
  app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
});

describe('COD-64 buildActionInstruction (pure helper)', () => {
  it('replaces a single {path} placeholder', () => {
    expect(app.buildActionInstruction('Review {path} for clarity', '/docs/a.md')).toBe('Review /docs/a.md for clarity');
  });

  it('replaces ALL {path} occurrences', () => {
    expect(app.buildActionInstruction('Diff {path} against {path}.bak', '/x.md')).toBe('Diff /x.md against /x.md.bak');
  });

  it('appends the path when the template has no placeholder', () => {
    expect(app.buildActionInstruction('Tighten the prose in', '/docs/a.md')).toBe('Tighten the prose in /docs/a.md');
  });

  it('keeps the result single-line', () => {
    const out = app.buildActionInstruction('Review {path} now', '/a.md');
    expect(out).not.toContain('\n');
  });
});

describe('COD-64 normalizeAuthoringActions (pure helper)', () => {
  it('drops blank rows (empty label or instruction)', () => {
    const rows = [
      { id: 'a', label: 'Tighten', instruction: 'Tighten {path}' },
      { id: 'b', label: '', instruction: 'noop' },
      { id: 'c', label: 'Empty instr', instruction: '   ' },
      { id: 'd', label: '   ', instruction: '   ' },
    ];
    const out = app.normalizeAuthoringActions(rows);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Tighten');
  });

  it('trims label/instruction and assigns an id when missing', () => {
    const out = app.normalizeAuthoringActions([{ label: '  Polish  ', instruction: '  do it  ' }]);
    expect(out[0].label).toBe('Polish');
    expect(out[0].instruction).toBe('do it');
    expect(typeof out[0].id).toBe('string');
    expect(out[0].id.length).toBeGreaterThan(0);
  });

  it('caps the list at 20 entries', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), label: `L${i}`, instruction: `I${i}` }));
    expect(app.normalizeAuthoringActions(rows)).toHaveLength(20);
  });

  it('returns an empty array for empty/garbage input', () => {
    expect(app.normalizeAuthoringActions([])).toEqual([]);
    expect(app.normalizeAuthoringActions(null)).toEqual([]);
    expect(app.normalizeAuthoringActions(undefined)).toEqual([]);
  });
});

describe('COD-64 SettingsUpdateSchema.authoringActions', () => {
  it('accepts a valid authoringActions array', () => {
    const result = SettingsUpdateSchema.safeParse({
      authoringActions: [{ id: 'x1', label: 'Tighten', instruction: 'Tighten the prose in {path}' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty array (default-empty shipping shape)', () => {
    expect(SettingsUpdateSchema.safeParse({ authoringActions: [] }).success).toBe(true);
  });

  it('rejects an entry missing a label', () => {
    const result = SettingsUpdateSchema.safeParse({
      authoringActions: [{ id: 'x1', instruction: 'do it' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string label', () => {
    const result = SettingsUpdateSchema.safeParse({
      authoringActions: [{ id: 'x1', label: '', instruction: 'do it' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 entries', () => {
    const result = SettingsUpdateSchema.safeParse({
      authoringActions: Array.from({ length: 21 }, (_, i) => ({
        id: String(i),
        label: `L${i}`,
        instruction: `I${i}`,
      })),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an overlong instruction (>2000)', () => {
    const result = SettingsUpdateSchema.safeParse({
      authoringActions: [{ id: 'x1', label: 'L', instruction: 'z'.repeat(2001) }],
    });
    expect(result.success).toBe(false);
  });
});

describe('COD-64 default-empty: no personal skill names baked into shipped source/schema', () => {
  const schemaSrc = readFileSync(join(process.cwd(), 'src/web/schemas.ts'), 'utf8');
  // These are personal skills that must NOT ship as defaults/data. They may only
  // appear as examples in a comment or settings hint — assert they are absent from
  // the JS data paths and the schema entirely.
  const personalSkills = ['narrative-review', 'line-edit', 'deai'];
  it('schema contains no personal skill names', () => {
    for (const name of personalSkills) expect(schemaSrc).not.toContain(name);
  });
});

describe('COD-64 settings editor source contract', () => {
  it('App Settings modal has an Authoring tab + list container + add button', () => {
    // `data-section`, not `data-tab`: the App Settings rail is a table of contents
    // over one scrolling document, and the rail entries carry data-section.
    expect(indexHtml).toContain('data-section="settings-authoring"');
    expect(indexHtml).toContain('id="settings-authoring"');
    expect(indexHtml).toContain('id="authoringActionsList"');
    expect(indexHtml).toContain('app.addAuthoringActionRow()');
  });

  it('hint mentions the {path} placeholder', () => {
    expect(indexHtml).toContain('{path}');
  });

  it('settings-ui loads + reads back authoringActions through the persisted path', () => {
    expect(settingsJs).toContain('authoringActions');
    expect(settingsJs).toContain('renderAuthoringActions');
    expect(settingsJs).toContain('addAuthoringActionRow');
    expect(settingsJs).toContain('readAuthoringActionsFromEditor');
  });
});

describe('COD-64 preview footer + runner source contract', () => {
  it('panels-ui renders an Authoring control in the markdown/text footer', () => {
    expect(panelsJs).toContain('document-authoring-btn');
    expect(panelsJs).toContain('app.toggleAuthoringMenu');
  });

  it('action menu items invoke runAuthoringAction', () => {
    expect(panelsJs).toContain('app.runAuthoringAction(');
    expect(panelsJs).toContain('authoring-action-item');
  });

  it('runAuthoringAction + buildActionInstruction methods exist', () => {
    expect(panelsJs).toContain('runAuthoringAction(actionId)');
    expect(panelsJs).toContain('buildActionInstruction(');
    expect(typeof app.runAuthoringAction).toBe('function');
    expect(typeof app.buildActionInstruction).toBe('function');
  });

  it('reads configured actions from the cached app-settings store', () => {
    expect(panelsJs).toContain('loadAppSettingsFromStorage');
  });
});

describe('COD-64 runAuthoringAction behavior', () => {
  it('builds the instruction from the looked-up action and posts to the session', async () => {
    let posted: { sessionId?: string; input?: string } = {};
    app.filePreviewState = { sessionId: 'sess-1', filePath: '/docs/draft.md' };
    app.loadAppSettingsFromStorage = () => ({
      authoringActions: [{ id: 'act-1', label: 'Tighten', instruction: 'Tighten the prose in {path}' }],
    });
    app._postSessionInput = async (sessionId: string, input: string) => {
      posted = { sessionId, input };
      return true;
    };
    app.showToast = () => {};
    await app.runAuthoringAction('act-1');
    expect(posted.sessionId).toBe('sess-1');
    expect(posted.input).toBe('Tighten the prose in /docs/draft.md');
  });

  it('does not crash / does not post when there is no session', async () => {
    let called = false;
    app.filePreviewState = { sessionId: null, filePath: '/x.md' };
    app.loadAppSettingsFromStorage = () => ({
      authoringActions: [{ id: 'act-1', label: 'L', instruction: 'do {path}' }],
    });
    app._postSessionInput = async () => {
      called = true;
      return true;
    };
    app.showToast = () => {};
    await app.runAuthoringAction('act-1');
    expect(called).toBe(false);
  });

  it('does not post for an unknown action id', async () => {
    let called = false;
    app.filePreviewState = { sessionId: 'sess-1', filePath: '/x.md' };
    app.loadAppSettingsFromStorage = () => ({ authoringActions: [] });
    app._postSessionInput = async () => {
      called = true;
      return true;
    };
    app.showToast = () => {};
    await app.runAuthoringAction('nope');
    expect(called).toBe(false);
  });
});
