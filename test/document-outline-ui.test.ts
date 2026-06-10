// @vitest-environment jsdom
/**
 * COD-62 — document-preview outline / reading-view / word-count.
 *
 * Pure-frontend feature layered onto the existing markdown/text preview overlay.
 * This suite drives the EXACT shipping artifacts under jsdom:
 *   - src/web/public/constants.js  (escapeHtml + helpers)
 *   - src/web/public/app.js        (CodemanApp class + _renderMarkdown)
 *   - src/web/public/panels-ui.js  (preview glue + the new outline/reading helpers)
 *
 * We test the pure helpers directly (outline building, word counting, reading-time
 * formatting) plus the DOM toggle glue. No port / server needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

let app: any;

beforeAll(() => {
  // The shipping modules are classic scripts whose top-level `const`/`function`
  // declarations share ONE global script scope in the browser. Indirect eval gives
  // each call its own scope, so constants.js's `const SSE_EVENTS` wouldn't be visible
  // to app.js. We concatenate the three files and eval them together (one scope), then
  // append a capture line to lift `CodemanApp` out of that scope.
  const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
  const combined =
    // Cross-module globals app.js re-exports at eval time (defined in sibling
    // modules we don't load here). Stubbed so the script evaluates; none of the
    // helpers under test touch them.
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
  // Construct a bare instance: we only call pure/DOM helpers that don't touch
  // network or session state. `$` reads this._elemCache (normally set by the
  // constructor we deliberately skip), so seed it.
  app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
});

describe('COD-62 word count + reading time', () => {
  it('counts whitespace-collapsed words, dropping empties', () => {
    expect(app._countWords('hello   world\n\nfoo\tbar')).toBe(4);
    expect(app._countWords('   ')).toBe(0);
    expect(app._countWords('')).toBe(0);
    expect(app._countWords('one')).toBe(1);
  });

  it('formats a locale-grouped reading meta string (200 wpm, min 1 min)', () => {
    // 400 words -> ~2 min read
    expect(app._formatReadingMeta(400)).toBe('400 words · ~2 min read');
    // thousands grouping
    expect(app._formatReadingMeta(1234)).toBe('1,234 words · ~6 min read');
    // floor clamps to at least 1 minute
    expect(app._formatReadingMeta(10)).toBe('10 words · ~1 min read');
    expect(app._formatReadingMeta(0)).toBe('0 words · ~1 min read');
  });

  it('produces a 400-word doc summary end to end', () => {
    const container = document.createElement('div');
    container.textContent = Array.from({ length: 400 }, () => 'word').join(' ');
    const meta = app._formatReadingMeta(app._countWords(container.textContent));
    expect(meta).toBe('400 words · ~2 min read');
  });
});

describe('COD-62 outline / TOC building', () => {
  function proseWith(html: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'document-preview-markdown rv-text';
    el.innerHTML = html;
    return el;
  }

  it('builds one nav entry per heading and assigns ids when >= 2 headings', () => {
    const prose = proseWith('<h1>Intro</h1><p>x</p><h2>Details</h2><h2>Details</h2>');
    const nav = app._buildDocumentOutline(prose);
    expect(nav).not.toBeNull();
    expect(nav.tagName).toBe('NAV');
    expect(nav.classList.contains('document-outline')).toBe(true);
    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(3);
    // every heading got an id
    const headings = prose.querySelectorAll('h1,h2,h3,h4,h5,h6');
    headings.forEach((h) => expect(h.id).toBeTruthy());
    // duplicate heading text deduped into distinct ids
    const ids = [...headings].map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    // link targets match heading ids and use heading textContent only
    expect(links[0].getAttribute('href')).toBe('#' + headings[0].id);
    expect(links[0].textContent).toBe('Intro');
  });

  it('returns null when fewer than 2 headings', () => {
    expect(app._buildDocumentOutline(proseWith('<h1>Only one</h1><p>body</p>'))).toBeNull();
    expect(app._buildDocumentOutline(proseWith('<p>no headings</p>'))).toBeNull();
  });

  it('preserves a pre-existing heading id rather than overwriting it', () => {
    const prose = proseWith('<h1 id="keep-me">A</h1><h2>B</h2>');
    app._buildDocumentOutline(prose);
    expect(prose.querySelector('h1')!.id).toBe('keep-me');
  });
});

describe('COD-62 reading-view toggle', () => {
  it('adds and removes the reading-view class on the prose container', () => {
    const overlay = document.createElement('div');
    overlay.id = 'filePreviewOverlay';
    const prose = document.createElement('div');
    prose.className = 'document-preview-markdown';
    overlay.appendChild(prose);
    document.body.appendChild(overlay);

    app.readingViewActive = false;
    app.toggleReadingView();
    expect(prose.classList.contains('reading-view')).toBe(true);
    app.toggleReadingView();
    expect(prose.classList.contains('reading-view')).toBe(false);

    overlay.remove();
  });
});

describe('COD-62 footer controls wiring (source contract)', () => {
  const panelsJs = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
  const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');

  it('exposes outline + reading-view toggle methods', () => {
    expect(typeof app.toggleDocumentOutline).toBe('function');
    expect(typeof app.toggleReadingView).toBe('function');
  });

  it('renders the reading-view footer button and a conditional outline button', () => {
    expect(panelsJs).toContain('app.toggleReadingView()');
    expect(panelsJs).toContain('app.toggleDocumentOutline()');
    expect(panelsJs).toContain('document-preview-layout');
    expect(panelsJs).toContain('document-outline');
  });

  it('persists outline + reading-view preferences in localStorage', () => {
    expect(panelsJs).toContain('codeman.preview.outlineOpen');
    expect(panelsJs).toContain('codeman.preview.readingView');
  });

  it('ships reading-view and outline styles', () => {
    expect(stylesCss).toContain('.document-preview-layout');
    expect(stylesCss).toContain('.document-outline');
    expect(stylesCss).toContain('reading-view');
  });
});
