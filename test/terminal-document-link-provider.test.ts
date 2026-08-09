import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Link = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (event: unknown, text: string) => void;
};

type FakeLine = { text: string; isWrapped?: boolean };

function displayCells(text: string): Array<{ chars: string; width: number }> {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of Array.from(text)) {
    if (/^\p{Mark}$/u.test(char) && cells.length > 0) {
      const base = cells.findLast((cell) => cell.width > 0);
      if (base) base.chars += char;
      continue;
    }
    const width = /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char)
      ? 2
      : 1;
    cells.push({ chars: char, width });
    if (width === 2) cells.push({ chars: '', width: 0 });
  }
  return cells;
}

function loadTerminalUiPrototype() {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const openSpy = vi.fn();
  const context = vm.createContext({
    console: { ...console, debug: vi.fn(), log: vi.fn() },
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: vi.fn(), documentElement: { dataset: {} } },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      open: openSpy,
      document: { documentElement: { dataset: {} } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return {
    proto: (context as { __proto: Record<string, (...args: any[]) => any> }).__proto,
    openSpy,
  };
}

function makeHarness(
  lines: FakeLine[] | string,
  options: { sessionId?: string; workingDir?: string; cols?: number } = {}
) {
  const { proto, openSpy } = loadTerminalUiPrototype();
  const sourceLines = typeof lines === 'string' ? [{ text: lines }] : lines;
  const cols = options.cols ?? Math.max(...sourceLines.map((line) => displayCells(line.text).length));
  const bufferLines = sourceLines.map((line) => {
    const cells = displayCells(line.text);
    while (cells.length < cols) cells.push({ chars: '', width: 1 });
    return {
      isWrapped: line.isWrapped ?? false,
      translateToString(trimRight?: boolean) {
        const value = cells
          .filter((cell) => cell.width > 0)
          .map((cell) => cell.chars || ' ')
          .join('');
        return trimRight ? value.trimEnd() : value;
      },
      getCell(index: number) {
        const cell = cells[index];
        if (!cell) return undefined;
        return {
          getChars: () => cell.chars,
          getWidth: () => cell.width,
        };
      },
    };
  });
  let provider: { provideLinks: (line: number, callback: (links?: Link[]) => void) => void } | undefined;
  const originalSessionId = options.sessionId ?? 'origin-session';
  const previewSpy = vi.fn();
  const fileUriSpy = vi.fn();
  const logSpy = vi.fn();
  const app = {
    terminal: {
      cols,
      rows: 24,
      registerLinkProvider(value: typeof provider) {
        provider = value;
      },
      element: {
        querySelector(selector: string) {
          return selector === '.xterm-screen'
            ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: cols * 10, height: 480 }) }
            : null;
        },
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
      buffer: {
        active: {
          viewportY: 0,
          getLine(index: number) {
            return bufferLines[index];
          },
        },
      },
    },
    activeSessionId: originalSessionId,
    sessions: new Map([[originalSessionId, { workingDir: options.workingDir ?? '/workspace/project' }]]),
    openFilePreview: previewSpy,
    openFileUriPreview: fileUriSpy,
    openLogViewerWindow: logSpy,
    _openTerminalUrl: proto._openTerminalUrl,
    _terminalCellFromClientPoint: proto._terminalCellFromClientPoint,
    _activateTerminalLinkAtPoint: proto._activateTerminalLinkAtPoint,
    registerFilePathLinkProvider: proto.registerFilePathLinkProvider,
  };
  app.registerFilePathLinkProvider.call(app);

  function provide(line = 1): Link[] {
    let links: Link[] | undefined;
    provider!.provideLinks(line, (value) => {
      links = value;
    });
    return links ?? [];
  }

  return { app, provide, previewSpy, fileUriSpy, logSpy, openSpy, originalSessionId };
}

describe('COD-232 terminal document link provider', () => {
  it('links a strict generated-image file URI before ordinary URL and path candidates', () => {
    const uri = 'file:///Users/saqeb/.codex-personal/generated_images/mockup.png';
    const { provide, fileUriSpy, openSpy, previewSpy, originalSessionId } = makeHarness(`Saved to: ${uri}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([uri]);
    links[0].activate(null, links[0].text);
    expect(fileUriSpy).toHaveBeenCalledWith(uri, originalSessionId);
    expect(openSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('preserves percent encoding while trimming sentence punctuation from a file URI', () => {
    const uri = 'file:///workspace/project/out/mockup%20one.pdf';
    const { provide, fileUriSpy, originalSessionId } = makeHarness(`Preview (${uri}).`);

    const [link] = provide();

    expect(link.text).toBe(uri);
    link.activate(null, link.text);
    expect(fileUriSpy).toHaveBeenCalledWith(uri, originalSessionId);
  });

  it.each([
    ['sentence punctuation', '.'],
    ['the following blank cell', ' '],
  ])('ends a single-row file URI on its final character before %s', (_label, suffix) => {
    const uri = 'file:///workspace/project/out/report.pdf';
    const { provide } = makeHarness(`${uri}${suffix}`);

    const [link] = provide();

    expect(link.range.end).toEqual({ x: uri.length, y: 1 });
  });

  it('does not activate a file URI when a touch lands on following punctuation', () => {
    const uri = 'file:///workspace/project/out/report.pdf';
    const { app, fileUriSpy } = makeHarness(`${uri}.`);

    expect(app._activateTerminalLinkAtPoint.call(app, (uri.length - 0.5) * 10, 10)).toBe(true);
    expect(app._activateTerminalLinkAtPoint.call(app, (uri.length + 0.5) * 10, 10)).toBe(false);
    expect(fileUriSpy).toHaveBeenCalledOnce();
  });

  it('does not link unsupported file URI extensions', () => {
    const { provide, fileUriSpy } = makeHarness('Saved to: file:///workspace/project/out/archive.zip');

    expect(provide()).toEqual([]);
    expect(fileUriSpy).not.toHaveBeenCalled();
  });

  it('does not link network authorities, relative forms, or a file prefix embedded in another token', () => {
    const { provide, fileUriSpy } = makeHarness(
      'file://server/share/report.pdf file:relative/report.pdf notfile:///workspace/out/report.pdf'
    );

    expect(provide()).toEqual([]);
    expect(fileUriSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['an embedded prefix', 'notfile:///tmp/report.pdf'],
    ['a colon-prefixed scheme', 'not:file:///tmp/report.pdf'],
    ['a relative file form', 'file:relative/tmp/report.pdf'],
    ['a network authority', 'file://server/tmp/report.pdf'],
    ['an over-limit URI token', `file:///${'a'.repeat(2001)}/tmp/report.pdf`],
  ])('does not let %s fall through to the legacy /tmp path detector', (_label, output) => {
    const { provide, fileUriSpy, logSpy } = makeHarness(output);

    expect(provide()).toEqual([]);
    expect(fileUriSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('preserves an ordinary standalone /tmp path that is not part of a file-scheme token', () => {
    const path = '/tmp/report.pdf';
    const { provide, previewSpy, originalSessionId } = makeHarness(`Inspect ${path}`);

    const [link] = provide();
    link.activate(null, link.text);

    expect(link.text).toBe(path);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });

  it('joins a wrapped file URI into one cross-row link', () => {
    const first = 'Saved file:///workspace/project/out/generated-';
    const second = 'mockup%20one.webp';
    const uri = 'file:///workspace/project/out/generated-mockup%20one.webp';
    const { provide } = makeHarness([{ text: first }, { text: second, isWrapped: true }], { cols: first.length });

    const [link] = provide(2);

    expect(link.text).toBe(uri);
    expect(link.range.start.y).toBe(1);
    expect(link.range.end.y).toBe(2);
  });

  it('ends a wrapped file URI on its final cell instead of the following punctuation cell', () => {
    const first = 'file:///workspace/project/out/generated-';
    const second = 'report.pdf.';
    const { provide } = makeHarness([{ text: first }, { text: second, isWrapped: true }], { cols: first.length });

    const [link] = provide(2);

    expect(link.range.end).toEqual({ x: second.length - 1, y: 2 });
  });

  it('captures the originating session for a file URI when links are provided', () => {
    const uri = 'file:///workspace/project/out/report.docx';
    const { app, provide, fileUriSpy, originalSessionId } = makeHarness(uri);
    const [link] = provide();

    app.activeSessionId = 'different-active-session';
    link.activate(null, link.text);

    expect(fileUriSpy).toHaveBeenCalledWith(uri, originalSessionId);
  });

  it('links the roadmap DOCX reference and opens the shared preview', () => {
    const path = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';
    const { provide, previewSpy, originalSessionId } = makeHarness(`Created ${path}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([path]);
    links[0].activate(null, links[0].text);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });

  it('links an XLSX reference and opens the spreadsheet preview for the originating session', () => {
    const path = 'out/cod-280-xlsx-live-test/deliverables/cod-280-live-card-test.xlsx';
    const { provide, previewSpy, originalSessionId } = makeHarness(`Created ${path}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([path]);
    links[0].activate(null, links[0].text);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });

  it('links every supported preview extension', () => {
    const extensions = [
      'pdf',
      'md',
      'txt',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'docx',
      'pptx',
      'xlsx',
      'json',
      'yaml',
      'yml',
      'csv',
      'xml',
      'sh',
      'py',
      'ts',
      'js',
    ];
    const paths = extensions.map((extension, index) => `out/file-${index}.${extension}`);
    const { provide } = makeHarness(paths.join(' '));

    expect(provide().map((link) => link.text)).toEqual(paths);
  });

  it('does not link SVG files that the shared viewer cannot render inline', () => {
    const { provide } = makeHarness('Created out/diagram.svg');

    expect(provide()).toEqual([]);
  });

  it('does not link legacy XLS files', () => {
    const { provide } = makeHarness('Created out/legacy-workbook.xls');

    expect(provide()).toEqual([]);
  });

  it('normalizes ./ paths and preserves spaces inside quotes and backticks', () => {
    const { provide, previewSpy } = makeHarness('See ./docs/guide.md, "out/final report.docx" and `out/Q3 deck.pptx`.');

    const links = provide();

    expect(links.map((link) => link.text)).toEqual(['./docs/guide.md', 'out/final report.docx', 'out/Q3 deck.pptx']);
    for (const link of links) link.activate(null, link.text);
    expect(previewSpy.mock.calls.map((call) => call[0])).toEqual([
      'docs/guide.md',
      'out/final report.docx',
      'out/Q3 deck.pptx',
    ]);
  });

  it('excludes trailing punctuation and returns distinct links for multiple paths', () => {
    const line = 'Files: (out/first.pdf), [docs/second.md]; and out/third.png!';
    const { provide } = makeHarness(line);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual(['out/first.pdf', 'docs/second.md', 'out/third.png']);
    expect(links.map((link) => line.slice(link.range.start.x - 1, link.range.end.x))).toEqual(
      links.map((link) => link.text)
    );
  });

  it('maps link ranges and touch hit tests through wide CJK cells', () => {
    const path = 'out/report.pdf';
    const { app, provide, previewSpy, originalSessionId } = makeHarness(`前置 ${path}`);
    const [link] = provide();

    expect(link.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 19, y: 1 } });
    expect(app._activateTerminalLinkAtPoint.call(app, 55, 10)).toBe(true);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });

  it('maps a combining sequence to one xterm cell before the link', () => {
    const path = 'out/report.pdf';
    const { provide } = makeHarness(`e\u0301 ${path}`);

    expect(provide()[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 16, y: 1 } });
  });

  it('does not let an unmatched prose apostrophe hide a later path', () => {
    const { provide } = makeHarness("Here's the generated file: out/report.pdf");

    expect(provide().map((link) => link.text)).toEqual(['out/report.pdf']);
  });

  it('keeps URL priority over document-looking URL paths', () => {
    const { provide, openSpy, previewSpy } = makeHarness('See https://example.com/out/report.pdf.');

    const links = provide();

    expect(links.map((link) => link.text)).toEqual(['https://example.com/out/report.pdf']);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledWith('https://example.com/out/report.pdf', '_blank', 'noopener,noreferrer');
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('keeps an ordinary URL link when its query contains a file URI value', () => {
    const url = 'https://example.com/?next=file:///tmp/report.pdf';
    const { provide, openSpy, fileUriSpy, logSpy, previewSpy } = makeHarness(`Continue at ${url}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([url]);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    expect(fileUriSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('keeps an assigned ordinary URL link when its query contains a file URI value', () => {
    const url = 'https://example.com/?next=file:///tmp/report.pdf';
    const { provide, openSpy, fileUriSpy, logSpy, previewSpy } = makeHarness(`url=${url}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([url]);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    expect(fileUriSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('keeps one assigned ordinary URL link when a later query parameter contains a file URI value', () => {
    const url = 'https://example.com/?x=1&next=file:///tmp/report.pdf';
    const { provide, openSpy, fileUriSpy, logSpy, previewSpy } = makeHarness(`url=${url}`);

    const links = provide();

    expect(links.map((link) => link.text)).toEqual([url]);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    expect(fileUriSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('preserves live-log routing while routing a document reference to preview', () => {
    const { provide, logSpy, previewSpy, originalSessionId } = makeHarness(
      'tail -f /var/log/app.log then inspect out/report.pdf'
    );

    const links = provide();

    expect(links.map((link) => link.text)).toEqual(['/var/log/app.log', 'out/report.pdf']);
    links[0].activate(null, links[0].text);
    links[1].activate(null, links[1].text);
    expect(logSpy).toHaveBeenCalledWith('/var/log/app.log', originalSessionId);
    expect(previewSpy).toHaveBeenCalledWith('out/report.pdf', originalSessionId);
  });

  it('preserves standalone legacy text links outside the session workspace', () => {
    const paths = ['/tmp/result.txt', '/tmp/result.json', '/tmp/result.md'];
    const { provide, logSpy, previewSpy, originalSessionId } = makeHarness(paths.join(' '));

    const links = provide();

    expect(links.map((link) => link.text)).toEqual(paths);
    for (const link of links) link.activate(null, link.text);
    expect(logSpy.mock.calls).toEqual(paths.map((path) => [path, originalSessionId]));
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('prefers document preview for a standalone legacy text path inside the workspace', () => {
    const path = '/workspace/project/out/result.md';
    const { provide, logSpy, previewSpy, originalSessionId } = makeHarness(path);

    const [link] = provide();
    link.activate(null, link.text);

    expect(previewSpy).toHaveBeenCalledWith('out/result.md', originalSessionId);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('captures the originating session when links are provided', () => {
    const { app, provide, previewSpy, originalSessionId } = makeHarness('Open out/report.pdf');
    const [link] = provide();

    app.activeSessionId = 'different-active-session';
    link.activate(null, link.text);

    expect(previewSpy).toHaveBeenCalledWith('out/report.pdf', originalSessionId);
  });

  it('normalizes absolute paths only when they are inside the known session workspace', () => {
    const workingDir = '/workspace/project';
    const { provide, previewSpy } = makeHarness(
      '/workspace/project/out/report.pdf /workspace/other/report.pdf /etc/secret.pdf',
      { workingDir }
    );

    const links = provide();

    // In-workspace absolute paths are normalized to a workspace-relative
    // preview path. Out-of-workspace paths under the well-known prefixes
    // (/etc here) still link via the legacy standalone-path fallback since
    // upstream's extPattern gained image/pdf extensions (pasted-attachment
    // paths) — the backend's validateSessionFilePath guard rejects reads
    // outside the workspace, so that link cannot expose foreign files.
    expect(links.map((link) => link.text)).toEqual(['/workspace/project/out/report.pdf', '/etc/secret.pdf']);
    links[0].activate(null, links[0].text);
    expect(previewSpy).toHaveBeenCalledWith('out/report.pdf', 'origin-session');
  });

  it('rejects traversal and bare dotted words', () => {
    const { provide, previewSpy } = makeHarness(
      '../secret.pdf out/../secret.pdf ./../secret.pdf note.md version.1.2 docs//report.pdf'
    );

    expect(provide()).toEqual([]);
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('joins wrapped xterm rows and returns one cross-row link', () => {
    const first = 'Created out/airdc/deliverables/fy27-airdc-';
    const second = 'messaging-market-story.docx';
    const { provide } = makeHarness([{ text: first }, { text: second, isWrapped: true }], { cols: first.length });

    const links = provide(2);

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('out/airdc/deliverables/fy27-airdc-messaging-market-story.docx');
    expect(links[0].range.start.y).toBe(1);
    expect(links[0].range.end.y).toBe(2);
  });

  it('maps a link starting exactly at a wrapped-row boundary to column one of the next row', () => {
    const first = 'prefix text ';
    const second = 'out/report.pdf';
    const { provide } = makeHarness([{ text: first }, { text: second, isWrapped: true }], { cols: first.length });

    const [link] = provide(2);

    expect(link.range.start).toEqual({ x: 1, y: 2 });
    expect(link.range.end).toEqual({ x: second.length, y: 2 });
  });

  it('maps a link ending exactly at a wrapped-row boundary to the final cell of the previous row', () => {
    const first = 'out/report.pdf';
    const second = ' continued';
    const { provide } = makeHarness([{ text: first }, { text: second, isWrapped: true }], { cols: first.length });

    const [link] = provide(1);

    expect(link.range.start).toEqual({ x: 1, y: 1 });
    expect(link.range.end).toEqual({ x: first.length, y: 1 });
  });

  it('stays linear on a long terminal line', () => {
    const line = `${'ordinary output '.repeat(20_000)}out/report.pdf`;
    const { provide } = makeHarness(line);

    const start = performance.now();
    const links = provide();
    const elapsed = performance.now() - start;

    expect(links.map((link) => link.text)).toEqual(['out/report.pdf']);
    expect(elapsed).toBeLessThan(500);
  });

  it('stays linear with thousands of distinct document references', () => {
    const paths = Array.from({ length: 5_000 }, (_, index) => `out/f${index}.md`);
    const { provide } = makeHarness(paths.join(' '));

    const start = performance.now();
    const links = provide();
    const elapsed = performance.now() - start;

    expect(links).toHaveLength(paths.length);
    expect(links[0].text).toBe(paths[0]);
    expect(links.at(-1)?.text).toBe(paths.at(-1));
    expect(elapsed).toBeLessThan(750);
  });

  it('uses linear occupied slots instead of per-link scans or sorting', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const provider = source.slice(
      source.indexOf('registerFilePathLinkProvider()'),
      source.indexOf('_openTerminalUrl(text)')
    );

    expect(provider).not.toContain('occupiedRanges.some');
    expect(provider).not.toContain('links.sort');
  });
});

describe('COD-237 unquoted absolute paths with spaces (own-line)', () => {
  const OBSERVED =
    '/mnt/c/Users/aakhter/OneDrive - Cisco/01_Projects/Other_Strategic/Projects/Source/kb/out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';
  const OBSERVED_REL =
    'OneDrive - Cisco/01_Projects/Other_Strategic/Projects/Source/kb/out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';

  it('links the exact observed WSL path with spaces as one reference and opens the DOCX', () => {
    const { provide, previewSpy, originalSessionId } = makeHarness(OBSERVED, {
      workingDir: '/mnt/c/Users/aakhter',
    });

    const links = provide();
    expect(links.map((link) => link.text)).toEqual([OBSERVED]);

    links[0].activate(null, links[0].text);
    expect(previewSpy).toHaveBeenCalledWith(OBSERVED_REL, originalSessionId);
  });

  it('links a shorter own-line spaced absolute path, preserving the spaces', () => {
    const { provide, previewSpy, originalSessionId } = makeHarness('/mnt/c/proj/My Big Docs/report.docx', {
      workingDir: '/mnt/c/proj',
    });

    expect(provide().map((link) => link.text)).toEqual(['/mnt/c/proj/My Big Docs/report.docx']);
    provide()[0].activate(null, provide()[0].text);
    expect(previewSpy).toHaveBeenCalledWith('My Big Docs/report.docx', originalSessionId);
  });

  it('tolerates a single trailing sentence period after the extension', () => {
    const { provide } = makeHarness('/mnt/c/proj/My Big Docs/report.docx.', { workingDir: '/mnt/c/proj' });
    expect(provide().map((link) => link.text)).toEqual(['/mnt/c/proj/My Big Docs/report.docx']);
  });

  it('does not link an out-of-workspace spaced absolute path as a whole reference', () => {
    // The spaced absolute path is outside the workspace, so the own-line heuristic
    // must not linkify it (any pre-existing relative-tail behaviour is unchanged).
    const { provide } = makeHarness('/etc/secret files/passwords.txt', { workingDir: '/mnt/c/proj' });
    expect(provide().map((link) => link.text)).not.toContain('/etc/secret files/passwords.txt');
  });

  it('rejects an own-line spaced path containing a .. traversal segment', () => {
    const { provide } = makeHarness('/mnt/c/proj/../other place/report.docx', { workingDir: '/mnt/c/proj' });
    expect(provide().map((link) => link.text)).not.toContain('/mnt/c/proj/../other place/report.docx');
  });

  it('does not link an own-line spaced path without a previewable extension', () => {
    const { provide } = makeHarness('/mnt/c/proj/My Big Docs/archive.tar', { workingDir: '/mnt/c/proj' });
    expect(provide()).toEqual([]);
  });

  it('does not merge two space-separated absolute paths into one link (single-path only)', () => {
    // Two absolute paths on one line must not collapse into one greedy reference.
    const { provide } = makeHarness('/mnt/c/proj/a.md /mnt/c/proj/b.pdf', { workingDir: '/mnt/c/proj' });
    const texts = provide().map((link) => link.text);
    expect(texts).not.toContain('/mnt/c/proj/a.md /mnt/c/proj/b.pdf');
  });

  it('regression: a quoted spaced path still links (COD-232 behaviour preserved)', () => {
    const { provide, previewSpy, originalSessionId } = makeHarness('Created "My Big Docs/report.docx" now', {
      workingDir: '/mnt/c/proj',
    });
    expect(provide().map((link) => link.text)).toEqual(['My Big Docs/report.docx']);
    provide()[0].activate(null, provide()[0].text);
    expect(previewSpy).toHaveBeenCalledWith('My Big Docs/report.docx', originalSessionId);
  });

  it('regression: an own-line no-space absolute path still links', () => {
    const { provide, previewSpy, originalSessionId } = makeHarness('/mnt/c/proj/docs/report.docx', {
      workingDir: '/mnt/c/proj',
    });
    expect(provide().map((link) => link.text)).toEqual(['/mnt/c/proj/docs/report.docx']);
    provide()[0].activate(null, provide()[0].text);
    expect(previewSpy).toHaveBeenCalledWith('docs/report.docx', originalSessionId);
  });
});

describe('COD-288 own-line spaced absolute path outside the workspace links nothing at all', () => {
  // The exact line from the report: an absolute path with spaces, outside the session
  // workspace. Before the fix the own-line rule recognized it, failed the workspace
  // confinement check, and fell through to the space-delimited token scanner — which
  // linked only the fragment after the LAST space as a bogus RELATIVE path.
  const REPORTED =
    '/mnt/c/Users/aakhter/Cisco/AI Ready Data Center Marketing - Documents/04 Moments and Activation/airdc-qtr-moments-future-plans/AIRDC-Quarterly-Moment-Strategic-Selection-and-Series-Plan.docx';
  const REPORTED_TAIL =
    'Activation/airdc-qtr-moments-future-plans/AIRDC-Quarterly-Moment-Strategic-Selection-and-Series-Plan.docx';

  it('links nothing for the reported out-of-workspace path (no trailing fragment)', () => {
    const { provide } = makeHarness(REPORTED, { workingDir: '/home/aakht/nas-docs' });
    expect(provide()).toEqual([]);
  });

  it('does not linkify the fragment after the last space as a relative path', () => {
    const { provide } = makeHarness(REPORTED, { workingDir: '/home/aakht/nas-docs' });
    expect(provide().map((link) => link.text)).not.toContain(REPORTED_TAIL);
  });

  it('regression: the same path inside the workspace still links in full and opens the preview', () => {
    const { provide, previewSpy, originalSessionId } = makeHarness(REPORTED, {
      workingDir: '/mnt/c/Users/aakhter/Cisco/AI Ready Data Center Marketing - Documents',
    });

    const links = provide();
    expect(links.map((link) => link.text)).toEqual([REPORTED]);
    links[0].activate(null, links[0].text);
    expect(previewSpy).toHaveBeenCalledWith(
      '04 Moments and Activation/airdc-qtr-moments-future-plans/AIRDC-Quarterly-Moment-Strategic-Selection-and-Series-Plan.docx',
      originalSessionId
    );
  });

  it('links nothing when a shorter out-of-workspace spaced path has a previewable tail', () => {
    const { provide } = makeHarness('/etc/secret files/notes/passwords.txt', { workingDir: '/mnt/c/proj' });
    expect(provide()).toEqual([]);
  });

  it('links no partial when the own-line spaced path contains a .. traversal segment', () => {
    // Traversal is refused for the same reason: the recognized line is ONE path, so a
    // relative tail out of it ("other place/report.docx" -> "place/report.docx") is a
    // partial that resolves to the wrong target.
    const { provide } = makeHarness('/mnt/c/proj/../other place/docs/report.docx', {
      workingDir: '/mnt/c/proj',
    });
    expect(provide()).toEqual([]);
  });

  it('regression: a spaced path embedded in prose is unchanged (not an own-line path)', () => {
    // Does not start with "/", so the own-line rule never fires and token scanning
    // keeps its pre-existing behaviour.
    const { provide, previewSpy, originalSessionId } = makeHarness('See docs/report.docx for details', {
      workingDir: '/mnt/c/proj',
    });
    expect(provide().map((link) => link.text)).toEqual(['docs/report.docx']);
    provide()[0].activate(null, provide()[0].text);
    expect(previewSpy).toHaveBeenCalledWith('docs/report.docx', originalSessionId);
  });

  it('regression: two space-separated absolute paths still fall through to token scanning', () => {
    // The own-line rule excludes lines with a second " /" segment, so suppression must
    // not reach them.
    const { provide } = makeHarness('/mnt/c/proj/a.md /mnt/c/proj/b.pdf', { workingDir: '/mnt/c/proj' });
    expect(provide().map((link) => link.text)).toEqual(['/mnt/c/proj/a.md', '/mnt/c/proj/b.pdf']);
  });

  it('regression: a quoted spaced path on its own line still links', () => {
    const { provide } = makeHarness('"My Big Docs/report.docx"', { workingDir: '/mnt/c/proj' });
    expect(provide().map((link) => link.text)).toEqual(['My Big Docs/report.docx']);
  });
});
