import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoteGeneratedArtifactCachePath,
  buildRemoteGeneratedArtifactFetchArgs,
  isAllowedGeneratedArtifactPath,
  registerGeneratedArtifactAttachment,
} from '../src/generated-artifact-attachments.js';
import { attachmentRegistry } from '../src/attachment-registry.js';
import type { SessionRemote } from '../src/types/session.js';

describe('generated artifact attachments', () => {
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
    const sessionId = 'generated-artifact-symlink-test';

    afterEach(async () => {
      attachmentRegistry.clearSession(sessionId);
      for (const dir of [workspaceDir, outsideDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      workspaceDir = undefined;
      outsideDir = undefined;
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
  });
});
