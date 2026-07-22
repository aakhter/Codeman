// @vitest-environment jsdom
/**
 * COD-95 — Highlight commented text in the document preview and allow editing
 * from the highlight.
 *
 * Drives the EXACT shipping artifacts under jsdom:
 *   - src/web/public/constants.js  (escapeHtml + helpers)
 *   - src/web/public/app.js        (CodemanApp class + _renderMarkdown)
 *   - src/web/public/panels-ui.js  (preview glue + the new highlight helpers)
 *
 * Covers:
 *   (a) creating a comment records a stable highlight anchor (quote + occurrence)
 *   (b) re-render re-applies the highlight span over the right occurrence
 *   (c) clicking a highlight opens the existing comment for editing
 *   (d) a non-findable anchor is skipped without throwing
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

let CodemanApp: { new (): any };
let app: any;

beforeAll(() => {
  const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
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
  CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
});

function makeApp(): any {
  const a = Object.create(CodemanApp.prototype);
  a._elemCache = {};
  a._annotations = [];
  a.showToast = () => {};
  return a;
}

/** A prose container holding text, matching the real `.document-preview-markdown`. */
function prose(html: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'document-preview-markdown rv-text';
  el.innerHTML = html;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  app = makeApp();
});

describe('COD-95 anchor recording', () => {
  it('records a stable quote + occurrence anchor when a comment is created', () => {
    const body = prose('<p>The quick brown fox jumps over the quick brown fox.</p>');
    body.id = 'previewProse';
    document.body.appendChild(body);

    // Anchor the SECOND occurrence of "quick brown fox".
    const anchor = app._buildCommentAnchor('quick brown fox', body, 1);
    expect(anchor).not.toBeNull();
    expect(anchor.quote).toBe('quick brown fox');
    expect(anchor.occurrence).toBe(1);
  });

  it('addAnnotation stores an anchor (id + quote + occurrence) on the annotation', () => {
    const body = prose('<p>alpha beta gamma alpha beta gamma</p>');
    document.body.appendChild(body);
    app._previewProseEl = () => body;

    // Simulate the popover flow: passage captured, occurrence resolved from the live
    // selection. Mirror commentOnSelection: open the popover, then set the pending
    // occurrence (opening clears any prior pending value).
    app._openAnnotationPopover('alpha beta');
    app._annotationPendingOccurrence = 1; // the second "alpha beta"
    const popNote = document.querySelector('.annotation-note') as HTMLTextAreaElement;
    popNote.value = 'tighten this';
    app.addAnnotation();

    expect(app._annotations.length).toBe(1);
    const a = app._annotations[0];
    expect(a.note).toBe('tighten this');
    expect(a.id).toBeTruthy();
    expect(a.anchor).toBeTruthy();
    expect(a.anchor.quote).toBe('alpha beta');
    expect(a.anchor.occurrence).toBe(1);
  });
});

describe('COD-95 re-apply highlight on render', () => {
  it('wraps the Nth occurrence of the quote in a comment-highlight span', () => {
    const body = prose('<p>one two three one two three</p>');
    document.body.appendChild(body);
    app._annotations = [{ id: 'c1', passage: 'two three', note: 'x', anchor: { quote: 'two three', occurrence: 1 } }];

    app._applyCommentHighlights(body);

    const spans = body.querySelectorAll('span.comment-highlight');
    expect(spans.length).toBe(1);
    expect(spans[0].getAttribute('data-comment-id')).toBe('c1');
    expect(spans[0].textContent).toBe('two three');
    // It must be the SECOND occurrence: the prose text up to the span must already
    // contain a "two three" (the first one), and overall there are two occurrences.
    const full = body.textContent!;
    expect(full.match(/two three/g)!.length).toBe(2);
    const range = document.createRange();
    range.selectNodeContents(body);
    range.setEnd(spans[0], 0);
    expect(range.toString()).toContain('two three');
  });

  it('highlights a quote that spans multiple text nodes', () => {
    const body = prose('<p>hello <strong>brave</strong> world</p>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'c2', passage: 'brave world', note: 'x', anchor: { quote: 'brave world', occurrence: 0 } },
    ];

    app._applyCommentHighlights(body);

    const spans = body.querySelectorAll('span.comment-highlight[data-comment-id="c2"]');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    // Concatenated highlighted text equals the quote.
    const joined = [...spans].map((s) => s.textContent).join('');
    expect(joined).toBe('brave world');
  });

  it('skips a non-findable anchor without throwing', () => {
    const body = prose('<p>the text changed entirely</p>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'gone', passage: 'no longer present', note: 'x', anchor: { quote: 'no longer present', occurrence: 0 } },
    ];

    expect(() => app._applyCommentHighlights(body)).not.toThrow();
    expect(body.querySelectorAll('span.comment-highlight').length).toBe(0);
  });
});

describe('COD-95 click-to-edit', () => {
  it('clicking a highlight opens the existing comment populated for editing', () => {
    const body = prose('<p>edit me please now</p>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'c3', passage: 'edit me', note: 'make shorter', anchor: { quote: 'edit me', occurrence: 0 } },
    ];
    app._applyCommentHighlights(body);

    const span = body.querySelector('span.comment-highlight[data-comment-id="c3"]') as HTMLElement;
    expect(span).not.toBeNull();
    span.click();

    const pop = document.getElementById('annotationPopover');
    expect(pop).not.toBeNull();
    const note = pop!.querySelector('.annotation-note') as HTMLTextAreaElement;
    expect(note.value).toBe('make shorter');
    // The popover is in edit mode for that comment id.
    expect(app._editingCommentId).toBe('c3');
  });

  it('saving an edited comment updates the existing annotation in place (no duplicate)', () => {
    const body = prose('<p>edit me please now</p>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'c4', passage: 'edit me', note: 'old note', anchor: { quote: 'edit me', occurrence: 0 } },
    ];
    app._previewProseEl = () => body;
    app._applyCommentHighlights(body);

    const span = body.querySelector('span.comment-highlight[data-comment-id="c4"]') as HTMLElement;
    span.click();
    const note = document.querySelector('.annotation-note') as HTMLTextAreaElement;
    note.value = 'new note';
    app.addAnnotation();

    expect(app._annotations.length).toBe(1);
    expect(app._annotations[0].id).toBe('c4');
    expect(app._annotations[0].note).toBe('new note');
  });
});

describe('COD-221 inline Word comment inspector', () => {
  function wordCommentPreview(): {
    preview: HTMLElement;
    marker: HTMLAnchorElement;
    card: HTMLElement;
    close: HTMLAnchorElement;
  } {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="document-preview-html rv-text">
        <p>Review this <mark>passage</mark><sup class="docx-comment-marker"><a href="#docx-comment-card-0" class="docx-comment-button" aria-expanded="false" aria-controls="docx-comment-card-0">[1]</a></sup><span id="docx-comment-card-0" class="docx-comment-card" hidden><span class="docx-comment-author">[1] Reviewer</span><span class="docx-comment-text">Tighten this sentence.</span><a href="#docx-comment-card-0" class="docx-comment-close" aria-label="Close comment 1">Close</a></span>.</p>
      </div>`;
    document.body.appendChild(body);
    app._bindDocxCommentInspector(body);
    const preview = body.querySelector('.document-preview-html') as HTMLElement;
    return {
      preview,
      marker: preview.querySelector('.docx-comment-button') as HTMLAnchorElement,
      card: preview.querySelector('.docx-comment-card') as HTMLElement,
      close: preview.querySelector('.docx-comment-close') as HTMLAnchorElement,
    };
  }

  it('opens locally without navigation, then closes and restores focus to the marker', () => {
    const { marker, card, close } = wordCommentPreview();
    expect(card.hidden).toBe(true);

    const openEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(marker.dispatchEvent(openEvent)).toBe(false);
    expect(window.location.hash).toBe('');
    expect(card.hidden).toBe(false);
    expect(marker.getAttribute('aria-expanded')).toBe('true');

    const closeEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(close.dispatchEvent(closeEvent)).toBe(false);
    expect(card.hidden).toBe(true);
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(marker);
  });

  it('closes the open inspector with Escape and returns focus to its marker', () => {
    const { preview, marker, card } = wordCommentPreview();
    marker.click();
    expect(card.hidden).toBe(false);

    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(card.hidden).toBe(true);
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(marker);
  });
});

describe('COD-100 highlight in the diff/Changes view', () => {
  /** A diff-prose container, matching the real `.document-preview-diff` (COD-68). */
  function diffProse(html: string): HTMLElement {
    const el = document.createElement('pre');
    el.className = 'document-preview-diff';
    el.innerHTML = html;
    return el;
  }

  it('re-applies a comment highlight onto the rendered diff body (COD-68 Changes view)', () => {
    // Diff ops render as <span>/<ins>/<del>; a commented passage living in the
    // unchanged context must still be highlighted in the Changes view.
    const body = diffProse('<span>The quick brown fox</span><ins> leaps</ins><span> over the lazy dog.</span>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'd1', passage: 'lazy dog', note: 'reconsider', anchor: { quote: 'lazy dog', occurrence: 0 } },
    ];

    app._applyCommentHighlights(body);

    const spans = body.querySelectorAll('span.comment-highlight[data-comment-id="d1"]');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect([...spans].map((s) => s.textContent).join('')).toBe('lazy dog');
  });

  it('highlights a quote that straddles an inserted (ins) diff op', () => {
    // The quote spans the boundary between an unchanged span and an <ins> op —
    // the collapsed-text walk must wrap across the ins node, same as multi-node prose.
    const body = diffProse('<span>brave</span><ins> new</ins><span> world</span>');
    document.body.appendChild(body);
    app._annotations = [
      { id: 'd2', passage: 'brave new world', note: 'x', anchor: { quote: 'brave new world', occurrence: 0 } },
    ];

    app._applyCommentHighlights(body);

    const spans = body.querySelectorAll('span.comment-highlight[data-comment-id="d2"]');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect([...spans].map((s) => s.textContent).join('')).toBe('brave new world');
  });

  it('clicking a highlight in the diff body opens the comment for editing', () => {
    const body = diffProse('<span>please edit me now</span>');
    body.id = 'filePreviewBody-diff';
    document.body.appendChild(body);
    app._previewProseEl = () => body;
    app._annotations = [{ id: 'd3', passage: 'edit me', note: 'shorten', anchor: { quote: 'edit me', occurrence: 0 } }];

    app._applyCommentHighlights(body);
    const span = body.querySelector('span.comment-highlight[data-comment-id="d3"]') as HTMLElement;
    expect(span).not.toBeNull();
    span.click();

    const pop = document.getElementById('annotationPopover');
    expect(pop).not.toBeNull();
    expect((pop!.querySelector('.annotation-note') as HTMLTextAreaElement).value).toBe('shorten');
    expect(app._editingCommentId).toBe('d3');
  });
});

describe('COD-95 source/style contract', () => {
  const panelsJs = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
  const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');

  it('re-applies highlights from the markdown render path', () => {
    expect(panelsJs).toContain('_applyCommentHighlights');
  });

  it('ships a comment-highlight style with pointer affordance', () => {
    expect(stylesCss).toContain('.comment-highlight');
    expect(stylesCss).toContain('cursor: pointer');
  });

  it('COD-100: the diff/Changes render path re-applies comment highlights', () => {
    // The _renderDocumentDiff body must run the COD-95 highlight pass so commented
    // passages stay visible while comparing versions (COD-68 intended both views).
    const defAt = panelsJs.indexOf('_renderDocumentDiff(versions, diff) {');
    const diffFn = panelsJs.slice(defAt);
    const body = diffFn.slice(0, diffFn.indexOf('\n  },'));
    expect(body).toContain('_applyCommentHighlights');
  });

  it('COD-100: _previewProseEl recognizes the diff container so click-to-edit works there', () => {
    expect(panelsJs).toContain('.document-preview-diff');
  });
});
