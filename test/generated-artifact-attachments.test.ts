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
  _parseRemoteGeneratedArtifactOutputForTest,
  _REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST,
  buildRemoteGeneratedArtifactCachePath,
  buildRemoteGeneratedArtifactInspectionArgs,
  isAllowedGeneratedArtifactPath,
  registerGeneratedArtifactAttachment,
} from '../src/generated-artifact-attachments.js';
import { attachmentRegistry, registerExternalAttachment } from '../src/attachment-registry.js';
import type { SessionRemote } from '../src/types/session.js';

const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;

function mockRemoteInspection(
  filePath: string,
  size: number,
  options: { workspace?: string; homes?: string[]; data?: Buffer } = {}
): void {
  mockRemoteCombinedOperation(
    buildRemoteOperationFrame({
      filePath,
      size,
      data: options.data ?? (size <= MAX_GENERATED_ARTIFACT_BYTES ? Buffer.alloc(size) : Buffer.alloc(0)),
      workspace: options.workspace,
      homes: options.homes,
    })
  );
}

function mockRemoteInspectionFields(fields: string[]): void {
  execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, { stdout: Buffer.from(`${fields.join('\0')}\0`), stderr: Buffer.alloc(0) });
    }
  });
}

function buildRemoteOperationFrame(options: {
  filePath: string;
  size: number;
  data: Buffer;
  dataSize?: number;
  workspace?: string;
  homes?: string[];
}): Buffer {
  const fields = [
    'FILE',
    options.filePath,
    'SIZE',
    String(options.size),
    ...(options.workspace ? ['WORKSPACE', options.workspace] : []),
    ...(options.homes ?? []).flatMap((home, index) => [`HOME${index}`, home]),
    'DATA_SIZE',
    String(options.dataSize ?? options.data.length),
  ];
  return Buffer.concat([Buffer.from(`${fields.join('\0')}\0DATA\0`), options.data]);
}

function mockRemoteCombinedOperation(frame: Buffer): void {
  execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, { stdout: frame, stderr: Buffer.alloc(0) });
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

  it('builds one descriptor-bound remote operation from the session SSH configuration', () => {
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

    const args = buildRemoteGeneratedArtifactInspectionArgs(
      remote,
      "/Users/aamer/.codex-personal/generated_images/a'b.png",
      true
    );

    expect(args.slice(0, -1)).toEqual([
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
    ]);
    expect(args.at(-1)).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/sh -c');
    expect(args.at(-1)).toContain("'/Users/aamer/.codex-personal/generated_images/a'\\''b.png'");
    expect(args.at(-1)).toMatch(/ stream 52428800$/);
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

  it('round-trips symlinks, spaces, binary bytes, and control names through the real shell protocol', async () => {
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const testRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-protocol-')));
    try {
      const workspace = join(testRoot, 'workspace with spaces');
      await fs.mkdir(workspace);
      const binaryBytes = Buffer.from([0, 1, 2, 9, 10, 13, 127, 128, 255]);
      const targetPath = join(workspace, 'binary target.png');
      const symlinkPath = join(workspace, 'preview link.png');
      await fs.writeFile(targetPath, binaryBytes);
      await fs.symlink(targetPath, symlinkPath);

      const output = actualChildProcess.execFileSync(
        '/bin/sh',
        [
          '-c',
          _REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST,
          'codeman-generated-artifact',
          symlinkPath,
          workspace,
          testRoot,
          testRoot,
          'stream',
          String(MAX_GENERATED_ARTIFACT_BYTES),
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 }
      );
      const parsed = _parseRemoteGeneratedArtifactOutputForTest(output, true);

      expect(parsed.filePath).toBe(await fs.realpath(targetPath));
      expect(parsed.workspace).toBe(workspace);
      expect(parsed.data).toEqual(binaryBytes);

      const oversizePath = join(workspace, 'oversize sparse.png');
      await fs.writeFile(oversizePath, '');
      await fs.truncate(oversizePath, MAX_GENERATED_ARTIFACT_BYTES + 1);
      const oversizeOutput = actualChildProcess.execFileSync(
        '/bin/sh',
        [
          '-c',
          _REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST,
          'codeman-generated-artifact',
          oversizePath,
          workspace,
          testRoot,
          testRoot,
          'stream',
          String(MAX_GENERATED_ARTIFACT_BYTES),
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 }
      );
      const oversizeParsed = _parseRemoteGeneratedArtifactOutputForTest(oversizeOutput, true);
      expect(oversizeParsed.size).toBe(MAX_GENERATED_ARTIFACT_BYTES + 1);
      expect(oversizeParsed.data).toEqual(Buffer.alloc(0));

      const controlPath = join(workspace, 'control\tname.png');
      await fs.writeFile(controlPath, binaryBytes);
      const controlOutput = actualChildProcess.execFileSync(
        '/bin/sh',
        [
          '-c',
          _REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST,
          'codeman-generated-artifact',
          controlPath,
          workspace,
          testRoot,
          testRoot,
          'stream',
          String(MAX_GENERATED_ARTIFACT_BYTES),
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 }
      );

      let controlError: unknown;
      try {
        _parseRemoteGeneratedArtifactOutputForTest(controlOutput, true);
      } catch (err) {
        controlError = err;
      }
      expect(controlError).toMatchObject({ message: 'Access to this file is blocked', statusCode: 403 });
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('maps an actual child-process maxBuffer error to a typed 413 without creating a cache file', async () => {
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const actualError = await new Promise<Error>((resolve, reject) => {
      actualChildProcess.execFile(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(1024))"],
        { encoding: 'buffer', maxBuffer: 8 },
        (err) => (err ? resolve(err) : reject(new Error('Expected maxBuffer failure')))
      );
    });
    expect(actualError).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });

    const sessionId = 'generated-artifact-real-maxbuffer-test';
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'mac-mini',
      host: '192.168.1.20',
      username: 'aamer',
      remotePath: '/Users/aamer/projects/app',
    };
    const remotePath = '/Users/aamer/projects/app/output/oversize.png';
    const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(actualError);
    });

    await expect(
      registerGeneratedArtifactAttachment({
        sessionId,
        filePath: remotePath,
        sessionWorkingDir: '/tmp',
        remote,
      })
    ).rejects.toMatchObject({ message: 'Attachment file is too large', statusCode: 413 });
    await expect(fs.stat(cachePath)).rejects.toThrow();
    attachmentRegistry.clearSession(sessionId);
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

    it('rejects a remote workspace symlink whose canonical target escapes the approved roots before cache registration', async () => {
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
      expect(execFile.mock.calls[0]?.[2]).toMatchObject({
        encoding: 'buffer',
        timeout: 30_000,
        maxBuffer: MAX_GENERATED_ARTIFACT_BYTES + 16 * 1024 + 1,
      });
      expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    });

    it.each([
      ['dotenv target', '/Users/aamer/projects/app/.env.txt', '/Users/aamer/projects/app'],
      ['SSH target', '/Users/aamer/.ssh/id_rsa.png', '/Users/aamer'],
      ['unsupported extension', '/Users/aamer/projects/app/output/payload.bin', '/Users/aamer/projects/app'],
    ])('rejects a canonical remote %s before cache registration', async (_case, canonicalPath, remotePath) => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-sensitive-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath,
      };
      const requestedPath = `${remotePath}/output/preview.png`;
      mockRemoteInspection(canonicalPath, 12, { workspace: remotePath, homes: ['/Users/aamer'] });

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
    });

    it('rejects a canonical remote path containing LF with a typed 403 before cache registration', async () => {
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

    it('rejects a remote artifact reported over 50 MiB before streaming bytes', async () => {
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

    it('rejects a framed remote size mismatch before writing the cache', async () => {
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
      mockRemoteCombinedOperation(
        buildRemoteOperationFrame({
          filePath: remotePath,
          size: 12,
          dataSize: 12,
          data: Buffer.from('short'),
          workspace: remote.remotePath,
        })
      );

      await expect(
        registerGeneratedArtifactAttachment({
          sessionId,
          filePath: remotePath,
          sessionWorkingDir: workspaceDir,
          remote,
        })
      ).rejects.toThrow('Invalid remote artifact inspection response');
      await expect(fs.stat(cachePath)).rejects.toThrow();
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('registers framed remote bytes from one descriptor-bound SSH operation', async () => {
      workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-remote-framed-')));
      const remote: SessionRemote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.1.20',
        username: 'aamer',
        remotePath: '/Users/aamer/projects/app',
      };
      const remotePath = '/Users/aamer/projects/app/output/mockup.png';
      const cachePath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
      generatedCacheDir = dirname(cachePath);
      const data = Buffer.from([0, 1, 2, 10, 13, 255]);
      mockRemoteCombinedOperation(
        buildRemoteOperationFrame({ filePath: remotePath, size: data.length, data, workspace: remote.remotePath })
      );

      const event = await registerGeneratedArtifactAttachment({
        sessionId,
        filePath: remotePath,
        sessionWorkingDir: workspaceDir,
        remote,
      });

      expect(event.fileName).toBe('mockup.png');
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['aamer@192.168.1.20']));
      expect(String(execFile.mock.calls[0]?.[1]?.at(-1))).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/sh -c');
      await expect(fs.readFile(cachePath)).resolves.toEqual(data);
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
      mockRemoteInspection(remotePath, 9, { homes: ['/Users/aamer'], data: Buffer.alloc(0) });
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
      mockRemoteInspection(remotePath, 9, { homes: ['/Users/aamer'], data: Buffer.alloc(0) });
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
