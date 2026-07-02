import { describe, expect, it } from 'vitest';
import {
  buildRemoteGeneratedArtifactCachePath,
  buildRemoteGeneratedArtifactFetchArgs,
  isAllowedGeneratedArtifactPath,
} from '../src/generated-artifact-attachments.js';
import type { SessionRemote } from '../src/types/session.js';

describe('generated artifact attachments', () => {
  it('allows workspace artifacts and known Codex generated image directories', () => {
    expect(isAllowedGeneratedArtifactPath('/repo/out/mockup.png', '/repo')).toBe(true);
    expect(isAllowedGeneratedArtifactPath('/Users/aamer/.codex-personal/generated_images/mockup.png', '/repo')).toBe(
      true
    );
    expect(isAllowedGeneratedArtifactPath('/etc/secret.png', '/repo')).toBe(false);
    expect(
      isAllowedGeneratedArtifactPath('/Users/aamer/.codex-personal/generated_images/../../.ssh/id_rsa.png', '/repo')
    ).toBe(false);
  });

  it('allows known Superpowers mockup artifact directories only', () => {
    expect(
      isAllowedGeneratedArtifactPath(
        '/Users/aamer/.config/superpowers/worktrees/flux-player/issue-268/output/playwright/mockup.png',
        '/Users/aamer/projects/flux-player'
      )
    ).toBe(true);
    expect(
      isAllowedGeneratedArtifactPath(
        '/Users/aamer/.config/superpowers/worktrees/flux-player/issue-268/docs/mockups/mockup.png',
        '/Users/aamer/projects/flux-player'
      )
    ).toBe(true);
    expect(
      isAllowedGeneratedArtifactPath(
        '/Users/aamer/.config/superpowers/worktrees/flux-player/issue-268/.env.png',
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
      '-o',
      'ConnectTimeout=10',
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
});
