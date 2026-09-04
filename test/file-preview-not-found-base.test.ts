/**
 * @fileoverview COD-387: a relative-path preview that 404s must name the
 * directory it was resolved against.
 *
 * COD-386 removed the common cause of a wrong base (relative links now resolve
 * against the pane's live cwd), but not the INVISIBILITY of a remaining one —
 * remote/Docker panes deliberately refuse a cwd, a session's cwd may not be
 * known yet, and a file can simply be missing. In all of those the user saw a
 * bare "File not found" with no way to tell which directory was searched, which
 * is what made the original bug hard to report.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

interface PreviewHost {
  openFilePreview: (filePath: string, sessionId?: string, attachmentId?: string | null) => Promise<void>;
  [key: string]: unknown;
}

/** Load panels-ui.js in a vm and return a host wired to a failing metadata fetch. */
function loadPreviewHost(session: Record<string, unknown> | undefined): {
  host: PreviewHost;
  bodyHtml: () => string;
} {
  const source = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
  const constants = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');
  const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const context = vm.createContext({
    console: { ...console, error: vi.fn() },
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    navigator: { userAgent: 'test' },
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { dataset: {} } },
    window: windowStub,
  });
  (context as { globalThis?: unknown }).globalThis = context;
  vm.runInContext(constants, context, { filename: 'constants.js' });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  const proto = (context as { __proto: Record<string, unknown> }).__proto;

  const elements: Record<
    string,
    { innerHTML: string; textContent: string; classList: { add: () => void }; hidden?: boolean }
  > = {};
  const el = () => ({ innerHTML: '', textContent: '', classList: { add: () => undefined, remove: () => undefined } });
  for (const id of ['filePreviewOverlay', 'filePreviewTitle', 'filePreviewBody', 'filePreviewFooter']) {
    elements[id] = el() as never;
  }

  const host = Object.create(proto) as PreviewHost;
  Object.assign(host, {
    $: (id: string) => elements[id] ?? null,
    sessions: new Map(session ? [['s1', session]] : []),
    activeSessionId: 's1',
    filePreviewState: null,
    _stopFilePreviewPolling: () => undefined,
    _startFilePreviewPolling: () => undefined,
    _restorePreviewSize: () => undefined,
    _hideFilePreviewNavigation: () => undefined,
    _loadFilePreviewNavigation: () => undefined,
    _closeAnnotationTray: () => undefined,
    _filePreviewSignature: () => 'sig',
    _renderFilePreviewBody: async () => true,
    // The 404 the workspace-confined route returns for a path that is not there.
    _fetchFilePreviewMetadata: async () => {
      throw new Error('File not found');
    },
  });
  return { host, bodyHtml: () => elements.filePreviewBody.innerHTML };
}

describe('COD-387 file preview names the base it resolved against', () => {
  it('names the pane cwd for a relative path in a local session', async () => {
    const { host, bodyHtml } = loadPreviewHost({
      id: 's1',
      workingDir: '/home/me/project',
      cwd: '/home/me/other-repo',
    });

    await host.openFilePreview('src/missing.txt', 's1');

    expect(bodyHtml()).toContain('File not found');
    // The cwd, not workingDir: that is the base the link actually resolved against.
    expect(bodyHtml()).toContain('/home/me/other-repo');
    expect(bodyHtml()).not.toContain('/home/me/project');
  });

  it('falls back to workingDir when no cwd is known', async () => {
    const { host, bodyHtml } = loadPreviewHost({ id: 's1', workingDir: '/home/me/project' });

    await host.openFilePreview('src/missing.txt', 's1');

    expect(bodyHtml()).toContain('/home/me/project');
  });

  it('uses workingDir for a remote session, which refuses a pane cwd', async () => {
    // The local pane runs the ssh client, so its cwd names a host directory the
    // agent was never in — COD-386 excludes those, and this message must agree
    // with the resolution rather than inventing its own answer.
    const { host, bodyHtml } = loadPreviewHost({
      id: 's1',
      workingDir: '/home/me/project',
      cwd: '/home/me/somewhere-local',
      remote: { host: 'box' },
    });

    await host.openFilePreview('src/missing.txt', 's1');

    expect(bodyHtml()).toContain('/home/me/project');
    expect(bodyHtml()).not.toContain('/home/me/somewhere-local');
  });

  it('says nothing about a base for an ABSOLUTE path', async () => {
    // An absolute path was not resolved against anything, so naming a directory
    // would be actively misleading.
    const { host, bodyHtml } = loadPreviewHost({
      id: 's1',
      workingDir: '/home/me/project',
      cwd: '/home/me/other-repo',
    });

    await host.openFilePreview('/etc/nope.txt', 's1');

    expect(bodyHtml()).toContain('File not found');
    expect(bodyHtml()).not.toContain('Searched in');
  });

  it('says nothing about a base when the session is unknown', async () => {
    const { host, bodyHtml } = loadPreviewHost(undefined);

    await host.openFilePreview('src/missing.txt', 's1');

    expect(bodyHtml()).toContain('File not found');
    expect(bodyHtml()).not.toContain('Searched in');
  });
});
