import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback(new Error('unexpected SSH invocation'));
  }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile };
});

import {
  buildRemoteGeneratedArtifactCachePath,
  buildRemoteGeneratedArtifactFetchArgs,
  isAllowedGeneratedArtifactPath,
  registerGeneratedArtifactAttachment,
} from '../src/generated-artifact-attachments.js';
import { attachmentRegistry, registerExternalAttachment } from '../src/attachment-registry.js';
import type { SessionRemote } from '../src/types/session.js';

const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;

function mockRemoteInspection(
  filePath: string,
  size: number,
  options: { workspace?: string; homes?: string[] } = {}
): void {
  const fields = [
    'FILE',
    filePath,
    'SIZE',
    String(size),
    ...(options.workspace ? ['WORKSPACE', options.workspace] : []),
    ...(options.homes ?? []).flatMap((home, index) => [`HOME${index}`, home]),
  ];
  mockRemoteInspectionFields(fields);
}

function mockRemoteInspectionFields(fields: string[]): void {
  execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, { stdout: Buffer.from(`${fields.join('\0')}\0`), stderr: Buffer.alloc(0) });
    }
  });
}

function mockRemoteFetch(stdout: Buffer): void {
  execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, { stdout, stderr: Buffer.alloc(0) });
  });
}

describe('generated artifact attachments', () => {
  afterEach(() => {
    execFile.mockClear();
  });

  it('allows workspace artifacts and known Codex generated image directories', () => {
    const home = homedir();
    expect(isAllowedGeneratedArtifactPath('/repo/out/mockup.png', '/repo')).toBe(true);
    expect(isAllowedGeneratedArtifactPath(join(home, '.codex-personal/generated_images/mockup.png'), '/repo')).toBe(
      true
    );
    expect(isAllowedGeneratedArtifactPath('/etc/secret.png', '/repo')).toBe(false);
    expect(
      isAllowedGeneratedArtifactPath(join(home, '.codex-personal/generated_images/../../.ssh/id_rsa.png'), '/repo')
    ).toBe(false);
    expect(isAllowedGeneratedArtifactPath('/var/tmp/staging/.codex/generated_images/leak.png', '/repo')).toBe(false);
  });

  it('allows known Superpowers mockup artifact directories only', () => {
    const home = homedir();
    expect(
      isAllowedGeneratedArtifactPath(
        join(home, '.config/superpowers/worktrees/flux-player/issue-268/output/playwright/mockup.png'),
        '/Users/aamer/projects/flux-player'
      )
    ).toBe(true);
    expect(
      isAllowedGeneratedArtifactPath(
        join(home, '.config/superpowers/worktrees/flux-player/issue-268/docs/mockups/mockup.png'),
        '/Users/aamer/projects/flux-player'
      )
    ).toBe(true);
    expect(
      isAllowedGeneratedArtifactPath(
        join(home, '.config/superpowers/worktrees/flux-player/issue-268/.env.png'),
        '/Users/aamer/projects/flux-player'
      )
    ).toBe(false);
  });

  it('builds remote fetch argv from the session SSH configuration', () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'mac-mini',
      host: '192.168.1.20',
      username: 'aamer',
      port: 2222,
      remotePath: '/Users/aamer/projects/app',
      identityFile: '~/.ssh/remote_ed25519',
      socksProxy: '127.0.0.1:1080',
      jumpHost: 'jump.example.com',
      extraSshOptions: ['StrictHostKeyChecking=no'],
    };

    expect(
      buildRemoteGeneratedArtifactFetchArgs(remote, "/Users/aamer/.codex-personal/generated_images/a'b.png")
    ).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-p',
      '2222',
      '-i',
      expect.stringMatching(/remote_ed25519$/),
      '-J',
      'jump.example.com',
      '-o',
      'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p',
      '-o',
      'StrictHostKeyChecking=no',
      'aamer@192.168.1.20',
      "cat -- '/Users/aamer/.codex-personal/generated_images/a'\\''b.png'",
    ]);
  });

  it('keeps the original remote filename as the cache basename', () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'mac-mini',
      host: '192.168.1.20',
      username: 'aamer',
      remotePath: '/Users/aamer/projects/app',
    };

    const cachePath = buildRemoteGeneratedArtifactCachePath(
      'session-123',
      remote,
      '/Users/aamer/.codex-personal/generated_images/mockup-final.png'
    );

    expect(cachePath.endsWith('/mockup-final.png')).toBe(true);
    expect(cachePath).toContain('/generated-artifacts/session-123/');
  });

  describe('symlink resolution', () => {
    let workspaceDir: string | undefined;
    let outsideDir: string | undefined;
    let generatedCacheDir: string | undefined;
    let generatedDataDir: string | undefined;
    let generatedDataDirLink: string | undefined;
    let originalDataDir: string | undefined;
    let dataDirOverridden = false;
    const sessionId = 'generated-artifact-symlink-test';

    afterEach(async () => {
      attachmentRegistry.clearSession(sessionId);
      for (const dir of [workspaceDir, outsideDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      if (generatedCacheDir) await fs.rm(generatedCacheDir, { recursive: true, force: true });
      if (dataDirOverridden) {
        if (originalDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
        else process.env.CODEMAN_DATA_DIR = originalDataDir;
      }
      for (const dir of [generatedDataDirLink, generatedDataDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      workspaceDir = undefined;
      outsideDir = undefined;
      generatedCacheDir = undefined;
      generatedDataDir = undefined;
      generatedDataDirLink = undefined;
      originalDataDir = undefined;
      dataDirOverridden = false;
    });

    it('rejects a workspace symlink to an outside file', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-ws-')));
      outsideDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-out-')));
      const outsideFile = join(outsideDir, 'private-notes.md');
      await fs.writeFile(outsideFile, 'secret');
      const linkPath = join(workspaceDir, 'x.md');
      await fs.symlink(outsideFile, linkPath);

      await expect(
        registerGeneratedArtifactAttachment({ sessionId, filePath: linkPath, sessionWorkingDir: workspaceDir })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('registers a real workspace file', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-ws-')));
      const filePath = join(workspaceDir, 'mockup.png');
      await fs.writeFile(filePath, 'png-bytes');

      const event = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath,
        sessionWorkingDir: workspaceDir,
      });

      expect(event.fileName).toBe('mockup.png');
      expect(event.attachmentType).toBe('image');
    });

    it('reuses an existing registration for the same resolved local artifact', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-dedupe-')));
      const filePath = join(workspaceDir, 'mockup.png');
      await fs.writeFile(filePath, 'png-bytes');

      const first = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath,
        sessionWorkingDir: workspaceDir,
      });
      const second = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath,
        sessionWorkingDir: workspaceDir,
      });

      expect(second.attachmentId).toBe(first.attachmentId);
      expect(attachmentRegistry.get(sessionId, first.attachmentId)?.filePath).toBe(filePath);
    });

    it('rejects a local generated artifact larger than 50 MiB before registration', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-local-large-')));
      const filePath = join(workspaceDir, 'oversize.png');
      await fs.writeFile(filePath, '');
      await fs.truncate(filePath, MAX_GENERATED_ARTIFACT_BYTES + 1);

      await expect(
        registerGeneratedArtifactAttachment({ sessionId, filePath, sessionWorkingDir: workspaceDir })
      ).rejects.toMatchObject({ statusCode: 413 });
      expect(attachmentRegistry.findByFilePath(sessionId, filePath)).toBeUndefined();
    });

    it('rejects lexical remote paths outside approved roots with a typed 403 before SSH', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-lexical-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: '/Users/aamer/private/mockup.png',
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ message: 'Access to this file is blocked', statusCode: 403 });
      expect(execFile).not.toHaveBeenCalled();
    });

    it.each(['\0', '\r', '\n'])('rejects remote paths containing %j before SSH', async (control) => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-control-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: `/Users/aamer/projects/app/mock${control}up.png`,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects a remote workspace symlink whose canonical target escapes the approved roots before byte fetch', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-escape-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const requestedPath = '/Users/aamer/projects/app/output/mockup.png';
      const escapedPath = '/Users/aamer/private/mockup.png';
      mockRemoteInspection(escapedPath, 12, {
        workspace: remote.remotePath,
        homes: ['/Users/aamer'],
      });

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: requestedPath,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({
        message: 'Access to this file is blocked',
        statusCode: 403,
      });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0]?.[2]).toMatchObject({ encoding: 'buffer', timeout: 10_000, maxBuffer: 16 * 1024 });
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });

    it('rejects a canonical remote path containing LF with a typed 403 before fetch or cache registration', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-lf-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const requestedPath = '/Users/aamer/projects/app/output/mockup.png';
      const canonicalPath = '/Users/aamer/projects/app/output/mock\nup.png';
      const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, requestedPath);
      mockRemoteInspection(canonicalPath, 12, { workspace: remote.remotePath });

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: requestedPath,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ message: 'Access to this file is blocked', statusCode: 403 });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
      expect(attachmentRegistry.findByFilePath(sessionId, cachePath)).toBeUndefined();
    });

    it('rejects control characters in the configured remote workspace before SSH', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-root-control-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app/poison\n/..',
      };

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: '/Users/aamer/projects/app/output/mockup.png',
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ message: 'Access to this file is blocked', statusCode: 403 });
      expect(execFile).not.toHaveBeenCalled();
    });

    it.each([
      ['odd field count', ['FILE', '/Users/aamer/projects/app/output/mockup.png', 'SIZE']],
      ['missing required field', ['FILE', '/Users/aamer/projects/app/output/mockup.png']],
      [
        'duplicate field',
        [
          'FILE',
          '/Users/aamer/projects/app/output/mockup.png',
          'SIZE',
          '12',
          'FILE',
          '/Users/aamer/projects/app/output/mockup.png',
        ],
      ],
    ])('rejects malformed NUL-delimited inspection output with %s', async (_case, fields) => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-malformed-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      mockRemoteInspectionFields(fields);

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: '/Users/aamer/projects/app/output/mockup.png',
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toThrow('Invalid remote artifact inspection response');
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });

    it('rejects a remote artifact reported over 50 MiB before byte fetch', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-large-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const remotePath = '/Users/aamer/projects/app/output/oversize.png';
      mockRemoteInspection(remotePath, MAX_GENERATED_ARTIFACT_BYTES + 1, { workspace: remote.remotePath });

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: remotePath,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ statusCode: 413 });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });

    it('rejects remote byte growth beyond 50 MiB before writing the cache', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-growth-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const remotePath = '/Users/aamer/projects/app/output/growing.png';
      const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
      generatedCacheDir = dirname(cachePath);
      mockRemoteInspection(remotePath, MAX_GENERATED_ARTIFACT_BYTES, { workspace: remote.remotePath });
      mockRemoteFetch(Buffer.alloc(MAX_GENERATED_ARTIFACT_BYTES + 1));

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: remotePath,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toMatchObject({ statusCode: 413 });
      await expect(fs.stat(cachePath)).rejects.toThrow();
      const fetchCall = execFile.mock.calls.find((call) => String(call[1]).includes('cat --'));
      expect(fetchCall?.[2]).toMatchObject({ maxBuffer: MAX_GENERATED_ARTIFACT_BYTES + 1 });
    });

    it('revalidates a locally registered artifact after it is deleted', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-deleted-')));
      const filePath = join(workspaceDir, 'mockup.png');
      await fs.writeFile(filePath, 'png-bytes');

      await registerGeneratedArtifactAttachment({
        sessionId,
        filePath,
        sessionWorkingDir: workspaceDir,
      });
      await fs.rm(filePath);

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath,
          sessionWorkingDir: workspaceDir,
        })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reuses a registered remote generated-artifact cache file after fresh inspection without byte fetch', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-dedupe-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const remotePath = '/Users/aamer/.codex-personal/generated_images/mockup.png';
      const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
      generatedCacheDir = dirname(cachePath);
      await fs.mkdir(generatedCacheDir, { recursive: true });
      await fs.writeFile(cachePath, 'png-bytes');

      const first = await registerExternalAttachment(sessionId, cachePath, { sessionWorkingDir: workspaceDir });
      mockRemoteInspection(remotePath, 9, { homes: ['/Users/aamer'] });
      const second = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath: remotePath,
        sessionWorkingDir: workspaceDir,
        remote,
      });

      expect(second.attachmentId).toBe(first.attachmentId);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });

    it('reuses a remote cache registration through a symlinked data directory after inspection without fetch', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-symlink-')));
      generatedDataDir = await fs.mkdtemp(join(tmpdir(), 'codeman-genart-data-'));
      generatedDataDirLink = `${generatedDataDir}-link`;
      await fs.symlink(generatedDataDir, generatedDataDirLink);
      originalDataDir = process.env.CODEMAN_DATA_DIR;
      process.env.CODEMAN_DATA_DIR = generatedDataDirLink;
      dataDirOverridden = true;

      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const remotePath = '/Users/aamer/.codex-personal/generated_images/mockup.png';
      const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
      await fs.mkdir(dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, 'png-bytes');

      const first = await registerExternalAttachment(sessionId, cachePath, { sessionWorkingDir: workspaceDir });
      mockRemoteInspection(remotePath, 9, { homes: ['/Users/aamer'] });
      const second = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath: remotePath,
        sessionWorkingDir: workspaceDir,
        remote,
      });

      expect(second.attachmentId).toBe(first.attachmentId);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });
  });
});
