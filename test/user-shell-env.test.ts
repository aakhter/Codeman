// test/user-shell-env.test.ts
import { describe, it, expect } from 'vitest';
import { buildUserShellEnvCommand } from '../src/utils/user-shell-env.js';

describe('buildUserShellEnvCommand', () => {
  it('re-execs the agent through `bash -lc` (login shell) for bash/unknown shells', () => {
    const out = buildUserShellEnvCommand({
      pathExport: 'export PATH="/home/u/.opencode/bin:$PATH"',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: 'opencode --model sonnet',
    });
    expect(out).toContain('exec bash -lc');
    expect(out).toContain(
      'export PATH="/home/u/.opencode/bin:$PATH" && export CODEMAN_MUX=1 && exec opencode --model sonnet'
    );
  });

  it('sources ~/.zshrc explicitly for zsh login shells (non-interactive zsh does NOT auto-source it)', () => {
    const out = buildUserShellEnvCommand({ cmd: 'opencode' });
    expect(out).toContain('exec zsh -lc');
    expect(out).toContain('source ~/.zshrc 2>/dev/null;');
  });

  it('keeps the final pane PID as the agent via a trailing exec', () => {
    const out = buildUserShellEnvCommand({ pathExport: 'export PATH="/x:$PATH"', cmd: 'opencode' });
    expect(out).toContain('export PATH="/x:$PATH" && exec opencode');
  });

  it('detects the login shell at runtime from $SHELL then getent', () => {
    const out = buildUserShellEnvCommand({ cmd: 'claude' });
    expect(out).toContain('login_shell=${SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}');
  });

  it('omits pathExport/envExports when not provided', () => {
    const out = buildUserShellEnvCommand({ cmd: 'codex' });
    expect(out).toContain('exec codex');
    expect(out).not.toContain('&& export');
  });

  it('does not emit a redundant wrapper when there is nothing to source (empty inputs still keep exec)', () => {
    const out = buildUserShellEnvCommand({ cmd: 'gemini' });
    expect(out).not.toContain('exec gemini &&');
    expect(out).toContain('exec gemini');
  });
});
