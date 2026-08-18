import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiPrototype() {
  // constants.js first: the file-path link pattern (absoluteFilePathPattern) is
  // single-sourced there and shared with the response viewer, so terminal-ui.js
  // references it at call time and the vm context has to carry it.
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
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
  vm.runInContext(`${constants}\n${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return {
    proto: (context as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto,
    openSpy,
  };
}

describe('terminal webexteams link provider', () => {
  it('linkifies a webexteams URI and opens it through the terminal URL helper', () => {
    const { proto, openSpy } = loadTerminalUiPrototype();
    let provider: { provideLinks: (line: number, cb: (links?: any[]) => void) => void } | null = null;
    const app = {
      terminal: {
        registerLinkProvider(p: typeof provider) {
          provider = p;
        },
        buffer: {
          active: {
            getLine() {
              return {
                translateToString() {
                  return 'join here webexteams://im?space=db14f330-717d-11f1-92da-c19ce73d6ecd&message=05032d90-7b3a-11f1-9f3d-f3d08f0a5540';
                },
              };
            },
          },
        },
      },
      activeSessionId: 'sess-1',
      openLogViewerWindow: vi.fn(),
      _openTerminalUrl: proto._openTerminalUrl,
      registerFilePathLinkProvider: proto.registerFilePathLinkProvider,
    };

    app.registerFilePathLinkProvider.call(app);
    expect(provider).not.toBeNull();

    let links: any[] | undefined;
    provider!.provideLinks(1, (value) => {
      links = value;
    });

    expect(links).toBeDefined();
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(
      'webexteams://im?space=db14f330-717d-11f1-92da-c19ce73d6ecd&message=05032d90-7b3a-11f1-9f3d-f3d08f0a5540'
    );

    links![0].activate(null, links![0].text);
    expect(openSpy).toHaveBeenCalledWith(
      'webexteams://im?space=db14f330-717d-11f1-92da-c19ce73d6ecd&message=05032d90-7b3a-11f1-9f3d-f3d08f0a5540',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
