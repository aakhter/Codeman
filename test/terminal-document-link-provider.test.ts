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

function loadTerminalUiPrototype() {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const openSpy = vi.fn();
  const context = vm.createContext({
    console,
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
  const bufferLines = (typeof lines === 'string' ? [{ text: lines }] : lines).map((line) => ({
    isWrapped: line.isWrapped ?? false,
    translateToString(trimRight?: boolean) {
      return trimRight ? line.text.trimEnd() : line.text.padEnd(options.cols ?? line.text.length);
    },
  }));
  let provider: { provideLinks: (line: number, callback: (links?: Link[]) => void) => void } | undefined;
  const originalSessionId = options.sessionId ?? 'origin-session';
  const previewSpy = vi.fn();
  const logSpy = vi.fn();
  const app = {
    terminal: {
      cols: options.cols ?? Math.max(...bufferLines.map((line) => line.translateToString(true).length)),
      registerLinkProvider(value: typeof provider) {
        provider = value;
      },
      buffer: {
        active: {
          getLine(index: number) {
            return bufferLines[index];
          },
        },
      },
    },
    activeSessionId: originalSessionId,
    sessions: new Map([[originalSessionId, { workingDir: options.workingDir ?? '/workspace/project' }]]),
    openFilePreview: previewSpy,
    openLogViewerWindow: logSpy,
    _openTerminalUrl: proto._openTerminalUrl,
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

  return { app, provide, previewSpy, logSpy, openSpy, originalSessionId };
}

describe('COD-232 terminal document link provider', () => {
  it('links the roadmap DOCX reference and opens the shared preview', () => {
    const path = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';
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
      'svg',
      'docx',
      'pptx',
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
    expect(links.map((link) => line.slice(link.range.start.x - 1, link.range.end.x - 1))).toEqual(
      links.map((link) => link.text)
    );
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

    expect(links.map((link) => link.text)).toEqual(['/workspace/project/out/report.pdf']);
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

  it('stays linear on a long terminal line', () => {
    const line = `${'ordinary output '.repeat(20_000)}out/report.pdf`;
    const { provide } = makeHarness(line);

    const start = performance.now();
    const links = provide();
    const elapsed = performance.now() - start;

    expect(links.map((link) => link.text)).toEqual(['out/report.pdf']);
    expect(elapsed).toBeLessThan(500);
  });
});
