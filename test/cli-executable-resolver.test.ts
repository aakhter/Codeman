import { describe, expect, it, vi } from 'vitest';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

function host(overrides: Partial<CliResolverHost> = {}): CliResolverHost {
  return {
    processPath: '/usr/bin:/bin',
    shellPath: '/bin/bash',
    shellArgs: ['-i', '-l'],
    findOnProcessPath: vi.fn(() => null),
    findInLoginShell: vi.fn(() => null),
    exists: vi.fn(() => false),
    ...overrides,
  };
}

describe('createCliExecutableResolver', () => {
  it('prefers the server process PATH over common directories and the login shell', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/process/bin/codex'),
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/process/bin/codex', source: 'process-path' });
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('prefers common directories in order over the login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn((path) => path === '/second/bin/codex' || path === '/shell/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/first/bin', '/second/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/second/bin/codex', source: 'common-directory' });
    expect(h.exists).toHaveBeenNthCalledWith(1, '/first/bin/codex');
    expect(h.exists).toHaveBeenNthCalledWith(2, '/second/bin/codex');
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('finds an executable exposed only by the interactive login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/home/u/.nvm/versions/node/v22/bin/codex'),
      exists: vi.fn((path) => path === '/home/u/.nvm/versions/node/v22/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.nvm/versions/node/v22/bin/codex',
      directory: '/home/u/.nvm/versions/node/v22/bin',
      source: 'login-shell',
    });
  });

  it('continues after a validator rejects an earlier candidate', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/usr/bin/pi'),
      findInLoginShell: vi.fn(() => '/home/u/.npm/bin/pi'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver(
      {
        binary: 'pi',
        searchDirs: [],
        validateCandidate: (path) =>
          path.includes('.npm') ? { accepted: true, metadata: '0.84.1' } : { accepted: false },
      },
      h
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.npm/bin/pi',
      source: 'login-shell',
      metadata: '0.84.1',
    });
  });

  it('caches success but retries failure', () => {
    const findInLoginShell = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue('/new/bin/codex');
    const h = host({ findInLoginShell, exists: vi.fn((path) => path === '/new/bin/codex') });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h);

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe binary names', () => {
    const h = host();

    expect(() => createCliExecutableResolver({ binary: 'codex;id', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
    expect(() => createCliExecutableResolver({ binary: '../codex', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
  });

  it('rejects relative and nonexistent candidates', () => {
    const findInLoginShell = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('relative/codex')
      .mockReturnValue('/missing/codex');
    const h = host({ findInLoginShell, exists: vi.fn(() => false) });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, h);

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull();
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.exists).toHaveBeenCalledWith('/missing/codex');
  });
});

describe('formatCliNotFoundMessage', () => {
  it('includes only the base install hint and bounded resolution diagnostics', () => {
    const base = 'Codex CLI not found. Install with: npm install -g @openai/codex';
    const diagnostics = {
      binary: 'codex',
      processPath: '/usr/bin:/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      searchDirs: ['/home/u/.local/bin', '/usr/local/bin'],
      API_KEY: 'super-secret',
    };
    const message = formatCliNotFoundMessage(base, diagnostics);

    expect(message).toContain(base);
    expect(message).toContain('Server PATH: /usr/bin:/bin');
    expect(message).toContain('Login shell: /bin/bash -i -l');
    expect(message).toContain('Checked directories: /home/u/.local/bin, /usr/local/bin');
    expect(message).not.toContain('API_KEY');
    expect(message).not.toContain('super-secret');
  });

  it('marks empty diagnostic values without dumping arbitrary environment data', () => {
    const message = formatCliNotFoundMessage('Missing CLI', {
      binary: 'codex',
      processPath: '',
      shellPath: '',
      shellArgs: [],
      searchDirs: [],
    });

    expect(message).toBe('Missing CLI\nServer PATH: (empty)\nLogin shell: (none)\nChecked directories: (none)');
    expect(message).not.toContain('HOME=');
    expect(message).not.toContain('TOKEN=');
  });
});
