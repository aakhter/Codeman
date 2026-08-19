import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyCodexRenderedState,
  detectClaudeCheckpointWorkingFrame,
  detectExternalCliWorkingFrame,
  Session,
} from '../src/session.js';
import { formatPaneSnapshot } from '../src/tmux-manager.js';

describe('Codex working detection', () => {
  it('detects Codex TUI working frames', () => {
    expect(detectExternalCliWorkingFrame('• Working (4m 03s • esc to interrupt)', 'codex')).toBe(true);
    expect(detectExternalCliWorkingFrame('• Working (2s • esc to interrupt)', 'codex')).toBe(true);
  });

  it('detects unit-less working frames (COD-175 prod screenshot shape)', () => {
    expect(detectExternalCliWorkingFrame('Working (31 • esc to interrupt)', 'codex')).toBe(true);
  });

  it('does not treat the idle Codex prompt as working', () => {
    const idlePrompt = '› Improve documentation in @filename\r\n\r\n  gpt-5.5 medium · /opt/projects/Codeman';

    expect(detectExternalCliWorkingFrame(idlePrompt, 'codex')).toBe(false);
  });

  it('does not treat MCP startup progress as working', () => {
    expect(
      detectExternalCliWorkingFrame('• Starting MCP servers (3/4): bitbucket (3s • esc to interrupt)', 'codex')
    ).toBe(false);
  });
});

describe('Codex rendered state classification', () => {
  it('gives working evidence precedence over a retained composer', () => {
    expect(classifyCodexRenderedState('• Working (31)\n› retained prompt')).toBe('working');
  });

  it('recognizes the Codex composer as input-ready', () => {
    expect(classifyCodexRenderedState('› Type your next prompt')).toBe('input-ready');
  });

  it('recognizes a selected numbered choice block as input-ready', () => {
    expect(classifyCodexRenderedState('Allow this command?\n❯ 1. Yes\n  2. No')).toBe('input-ready');
  });

  it('recognizes parenthesized numbered choices as input-ready', () => {
    expect(classifyCodexRenderedState('Allow this command?\n› 1) Yes\n  2) No')).toBe('input-ready');
    expect(classifyCodexRenderedState('Allow this command?\n❯ 1) Yes\n  2) No')).toBe('input-ready');
  });

  it('recognizes a numbered choice block after selection moves to option 2', () => {
    expect(classifyCodexRenderedState('Allow this command?\n  1. Yes\n❯ 2. No')).toBe('input-ready');
  });

  it('recognizes a multi-option dialog after selection moves to option 3', () => {
    expect(classifyCodexRenderedState('Choose a scope:\n  1. File\n  2. Folder\n❯ 3. Workspace')).toBe('input-ready');
  });

  it('returns unknown for plain tool output and absent frames', () => {
    expect(classifyCodexRenderedState('Read package.json\nCompleted in 12ms')).toBe('unknown');
    expect(classifyCodexRenderedState(null)).toBe('unknown');
  });

  it('normalizes ANSI and absolute-row tmux snapshots before classifying', () => {
    const frame = formatPaneSnapshot(['Codex CLI', '\x1b[32m› Type your next prompt\x1b[0m'], {
      cols: 80,
      rows: 4,
      cursorX: 2,
      cursorY: 1,
    });

    expect(frame).not.toContain('\n');
    expect(classifyCodexRenderedState(frame)).toBe('input-ready');
  });
});

describe('Claude checkpoint working detection', () => {
  it('detects an in-progress compaction row', () => {
    // Verbatim prod shape: Claude keeps the `❯` input row visible throughout,
    // so this row is the only positive evidence the operation is running.
    expect(detectClaudeCheckpointWorkingFrame('  ✽ Compacting conversation… (55s) ▰▰▰▰▰▰▱▱▱▱▱▱▱▱ 46%')).toBe(true);
  });

  it('detects the EARLY compaction row, before any timer or percentage', () => {
    // Captured verbatim from a live pane ~2s after `/compact`. The timer and
    // percentage only appear ~15s in, long after the 8s acceptance window, so
    // requiring them means the driver times out on every real compaction.
    expect(detectClaudeCheckpointWorkingFrame('✢ Compacting conversation… ')).toBe(true);
  });

  it('detects an in-progress thinking row', () => {
    expect(detectClaudeCheckpointWorkingFrame('✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)')).toBe(true);
  });

  it('still detects the legacy braille spinner', () => {
    expect(detectClaudeCheckpointWorkingFrame('⠋ Thinking…')).toBe(true);
  });

  it('does not treat a COMPLETED row as working', () => {
    // These persist on screen while Claude sits idle at the prompt. Reading
    // them as working would keep `ready` false forever and stall every
    // checkpoint in `waiting-ready`.
    expect(detectClaudeCheckpointWorkingFrame('✻ Cogitated for 5s')).toBe(false);
    expect(detectClaudeCheckpointWorkingFrame('✻ Crunched for 2s')).toBe(false);
    expect(detectClaudeCheckpointWorkingFrame('  ⎿  Compacted (ctrl+o to see full summary)')).toBe(false);
  });

  it('does not treat an idle Claude prompt as working', () => {
    expect(detectClaudeCheckpointWorkingFrame('❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe(false);
  });

  it('does not treat an ellipsis in the input row or footer as working', () => {
    // The `❯` row carries ghost-suggestion text and the footer carries a
    // middle-truncated path; both legitimately contain `…` while Claude is idle.
    expect(detectClaudeCheckpointWorkingFrame('❯ List 4 instruments…')).toBe(false);
    expect(detectClaudeCheckpointWorkingFrame('  aakht@aa-desktop:/tmp/scratchpad/ckpt-veri…')).toBe(false);
  });
});

describe('checkpoint prompt observations', () => {
  function installFrame(session: Session, getFrame: () => string): void {
    const internals = session as unknown as {
      _mux: {
        captureActivePaneBuffer: (muxName: string) => string;
        sendCheckpointCommand: () => Promise<{ ok: true }>;
      };
      _muxSession: { muxName: string };
    };
    internals._mux = { captureActivePaneBuffer: getFrame, sendCheckpointCommand: async () => ({ ok: true }) };
    internals._muxSession = { muxName: 'codeman-abc12345' };
  }

  it('requires the mode-specific rendered input prompt', async () => {
    const codex = new Session({ workingDir: '/tmp', mode: 'codex' });
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    let codexFrame = 'false idle without a prompt';
    let claudeFrame = 'false idle without a prompt';
    installFrame(codex, () => codexFrame);
    installFrame(claude, () => claudeFrame);

    expect(codex.getCheckpointObservation()).toMatchObject({ ready: false, working: false });
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: false, working: false });
    codexFrame = '› Ask Codex';
    claudeFrame = '❯ Ask Claude';
    expect(codex.getCheckpointObservation()).toMatchObject({ ready: true, working: false });
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: true, working: false });

    codexFrame = '❯ wrong prompt';
    claudeFrame = '› wrong prompt';
    expect(codex.getCheckpointObservation().ready).toBe(false);
    expect(claude.getCheckpointObservation().ready).toBe(false);
    await codex.stop();
    await claude.stop();
  });

  it('lets working evidence override a visible prompt', async () => {
    const codex = new Session({ workingDir: '/tmp', mode: 'codex' });
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    installFrame(codex, () => '• Working (2s • esc to interrupt)\n› prompt');
    installFrame(claude, () => '⠋ Thinking…\n❯ prompt');

    expect(codex.getCheckpointObservation()).toMatchObject({ ready: false, working: true });
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: false, working: true });
    await codex.stop();
    await claude.stop();
  });

  it('does not treat retained submitted input as ready in supported Codex working layouts', async () => {
    const codex = new Session({ workingDir: '/tmp', mode: 'codex' });
    installFrame(codex, () => '• Working (2s)\n› ask\n  gpt-5.5 xhigh fast · codeman · Working · Context 79% left');

    expect(codex.getCheckpointObservation()).toMatchObject({ ready: false, working: true });
    await codex.stop();
  });

  it('recognizes Codex prompts in absolute-row tmux snapshots without weakening working evidence', async () => {
    const codex = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = formatPaneSnapshot(['Codex CLI', '', '› Ask Codex', '', '  gpt-5.5 medium · /tmp'], {
      cols: 80,
      rows: 8,
      cursorX: 2,
      cursorY: 2,
    });
    installFrame(codex, () => frame);

    expect(frame).not.toContain('\n');
    expect(codex.getCheckpointObservation()).toMatchObject({ ready: true, working: false });

    frame = formatPaneSnapshot(
      ['Codex CLI', '• Working (2s)', '› ask', '', '  gpt-5.5 xhigh · codeman · Working · Context 79% left'],
      { cols: 80, rows: 8, cursorX: 4, cursorY: 2 }
    );
    expect(codex.getCheckpointObservation()).toMatchObject({ ready: false, working: true });
    await codex.stop();
  });

  it('recognizes Claude prompts in absolute-row tmux snapshots', async () => {
    // Every checkpoint mode waits for readiness first, so a prompt the
    // observation cannot see is a `readiness-timeout` for the whole driver.
    // The frame must come from formatPaneSnapshot: it paints rows with
    // absolute cursor moves and no EOLs, which a hand-written '❯ prompt'
    // string does not reproduce.
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    let frame = formatPaneSnapshot(
      [
        '╭─── Claude Code v2.1.224 ───╮',
        '│  Welcome back!             │',
        '╰────────────────────────────╯',
        '❯ ',
        '  bypass permissions on',
      ],
      { cols: 80, rows: 8, cursorX: 2, cursorY: 3 }
    );
    installFrame(claude, () => frame);

    expect(frame).not.toContain('\n');
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: true, working: false });

    frame = formatPaneSnapshot(
      ['╭─── Claude Code ───╮', '⠋ Thinking… (esc to interrupt)', '❯ ', '  bypass permissions on'],
      {
        cols: 80,
        rows: 8,
        cursorX: 2,
        cursorY: 2,
      }
    );
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: false, working: true });
    await claude.stop();
  });

  it('treats a Claude compaction screen as working and completes the ready cycle', async () => {
    // Verbatim prod capture: `/compact` echoed, the progress row, and an EMPTY
    // `❯` input row that stays visible for the whole operation. Prompt
    // visibility alone therefore cannot mean ready, or the driver reports
    // `operation-not-accepted` while the compaction is plainly running.
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    const geometry = { cols: 120, rows: 10, cursorX: 2, cursorY: 6 };
    const idleRows = [
      '● Mercury, Venus, Mars, Neptune.',
      '✻ Cogitated for 5s',
      '─────',
      '❯ ',
      '─────',
      '  ⏵⏵ bypass permissions on',
    ];
    const compactingRows = [
      '● Mercury, Venus, Mars, Neptune.',
      '✻ Cogitated for 5s',
      '❯ /compact',
      '✢ Compacting conversation… ',
      '─────',
      '❯ ',
      '─────',
      '  ⏵⏵ bypass permissions on',
    ];
    const doneRows = [
      '❯ /compact',
      '  ⎿  Compacted (ctrl+o to see full summary)',
      '─────',
      '❯ ',
      '─────',
      '  ⏵⏵ bypass permissions on',
    ];

    let frame = formatPaneSnapshot(idleRows, geometry);
    installFrame(claude, () => frame);
    const baseline = claude.getCheckpointObservation();
    expect(baseline).toMatchObject({ ready: true, working: false });

    frame = formatPaneSnapshot(compactingRows, geometry);
    expect(claude.getCheckpointObservation()).toMatchObject({ ready: false, working: true });

    // Completion must produce a NEW ready generation, which is what the
    // driver's `revision > baseline.revision` completion gate waits on.
    frame = formatPaneSnapshot(doneRows, geometry);
    const completed = claude.getCheckpointObservation();
    expect(completed.ready).toBe(true);
    expect(completed.revision).toBeGreaterThan(baseline.revision);
    await claude.stop();
  });

  it('increments semantic revision only after leaving and returning to ready', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = '› prompt';
    installFrame(session, () => frame);

    const baseline = session.getCheckpointObservation();
    expect(session.getCheckpointObservation().revision).toBe(baseline.revision);
    frame = 'status repaint\n› prompt';
    expect(session.getCheckpointObservation().revision).toBe(baseline.revision);
    frame = '• Working (1s • esc to interrupt)\n› prompt';
    expect(session.getCheckpointObservation().ready).toBe(false);
    frame = '› prompt';
    expect(session.getCheckpointObservation().revision).toBe(baseline.revision + 1);
    await session.stop();
  });

  it('does not invent a prompt transition when a rendered capture is temporarily unavailable', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = '› prompt';
    installFrame(session, () => frame);
    const baseline = session.getCheckpointObservation();

    frame = '';
    expect(session.getCheckpointObservation()).toEqual(baseline);
    frame = '› prompt';
    expect(session.getCheckpointObservation()).toEqual(baseline);
    await session.stop();
  });

  it('advances semantic prompt generation for an instantaneous clear frame but not a status redraw', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = 'previous conversation output\n› prompt\n  gpt-5.5 medium · /tmp';
    installFrame(session, () => frame);
    const baseline = session.getCheckpointObservation();

    frame = 'previous conversation output\n› prompt\n  gpt-5.5 high · /tmp';
    expect(session.getCheckpointObservation().revision).toBe(baseline.revision);

    await session.writeCheckpointViaMux('/clear\r');
    frame = 'fresh session banner\n› prompt\n  gpt-5.5 high · /tmp';
    expect(session.getCheckpointObservation()).toMatchObject({
      ready: true,
      working: false,
      revision: baseline.revision + 1,
    });
    await session.stop();
  });

  it('does not treat checkpoint clear/new commands as viewer history submissions', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    expect(session.lastSubmitAt).toBe(0);
    await session.writeCheckpointViaMux('/clear\r');
    expect(session.lastSubmitAt).toBe(0);
    await session.writeCheckpointViaMux('/new\r');
    expect(session.lastSubmitAt).toBe(0);
    await session.stop();
  });

  it('fences a cancelled checkpoint while Codex owned-ID snapshot preparation is pending', async () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let resolveFirstSnapshot!: (ids: string[]) => void;
    let resolveSecondSnapshot!: (ids: string[]) => void;
    const firstSnapshotPending = new Promise<string[]>((resolve) => {
      resolveFirstSnapshot = resolve;
    });
    const secondSnapshotPending = new Promise<string[]>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    const sendCheckpointCommand = vi.fn(async () => ({ ok: true as const, attempt: 1 }));
    const internals = session as unknown as {
      _findRecentOwnedCodexConversationIds: ReturnType<typeof vi.fn>;
      getCheckpointAutomationObservation: () => Promise<{
        ready: boolean;
        working: boolean;
        revision: number;
        conversationId: string;
      }>;
      _mux: { captureActivePaneBuffer: () => string; sendCheckpointCommand: typeof sendCheckpointCommand };
      _muxSession: { muxName: string };
    };
    internals._findRecentOwnedCodexConversationIds = vi
      .fn()
      .mockImplementationOnce(() => firstSnapshotPending)
      .mockImplementationOnce(() => secondSnapshotPending);
    internals.getCheckpointAutomationObservation = async () => ({
      ready: true,
      working: false,
      revision: 1,
      conversationId: 'baseline-conversation',
    });
    internals._mux = { captureActivePaneBuffer: () => '› prompt', sendCheckpointCommand };
    internals._muxSession = { muxName: 'codeman-race' };
    session.setCheckpoint(true, ['new']);

    const request = session.requestCheckpoint({ mode: 'new' });
    await vi.advanceTimersByTimeAsync(0);
    expect(internals._findRecentOwnedCodexConversationIds).toHaveBeenCalledOnce();
    session.cancelCheckpoint('manual-takeover');
    const newer = session.requestCheckpoint({ mode: 'new' });
    await vi.advanceTimersByTimeAsync(0);
    expect(internals._findRecentOwnedCodexConversationIds).toHaveBeenCalledTimes(2);

    resolveFirstSnapshot([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCheckpointCommand).not.toHaveBeenCalled();
    expect(session.checkpointStates[request.runId!]).toMatchObject({
      runId: request.runId,
      status: 'cancelled',
      reason: 'manual-takeover',
    });

    resolveSecondSnapshot([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCheckpointCommand).toHaveBeenCalledTimes(1);
    expect(sendCheckpointCommand).toHaveBeenCalledWith(session.id, '/new\r');
    expect(session.checkpointState).toMatchObject({ runId: newer.runId, status: 'running' });
    await session.stop();
    vi.useRealTimers();
  });

  it('does not advance clear generation when Codex appends a command rejection to the prior frame', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = 'previous conversation output\n› prompt\n  gpt-5.5 medium · /tmp';
    installFrame(session, () => frame);
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    frame = 'previous conversation output\nError: unknown command /clear\n› prompt\n  gpt-5.5 medium · /tmp';

    expect(session.getCheckpointObservation()).toEqual(baseline);
    await session.stop();
  });

  it('does not advance clear generation for an unrelated notice appended to the prior frame', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    let frame = 'previous conversation output\n› prompt\n  gpt-5.5 medium · /tmp';
    installFrame(session, () => frame);
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    frame = 'previous conversation output\nBackground sync complete\n› prompt\n  gpt-5.5 medium · /tmp';

    expect(session.getCheckpointObservation()).toEqual(baseline);
    await session.stop();
  });

  it('tracks a successful direct-PTY Claude clear generation while continuously ready', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const internals = session as unknown as {
      ptyProcess: { write: (data: string) => void };
      _lastPromptTime: number;
      _status: 'idle';
      _detectInteractiveActivity(data: string): void;
    };
    internals.ptyProcess = { write: vi.fn() };
    internals._lastPromptTime = 1;
    internals._status = 'idle';
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    internals._detectInteractiveActivity('\x1b[2J\x1b[Hfresh Claude prompt\n❯');

    expect(session.getCheckpointObservation()).toMatchObject({
      ready: true,
      working: false,
      revision: baseline.revision + 1,
    });
    await session.stop();
  });

  it('does not track a rejected direct-PTY Claude clear as a fresh generation', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const internals = session as unknown as {
      ptyProcess: { write: (data: string) => void };
      _lastPromptTime: number;
      _status: 'idle';
      _detectInteractiveActivity(data: string): void;
    };
    internals.ptyProcess = { write: vi.fn() };
    internals._lastPromptTime = 1;
    internals._status = 'idle';
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    internals._detectInteractiveActivity('Error: unknown command /clear\n❯');

    expect(session.getCheckpointObservation()).toEqual(baseline);
    await session.stop();
  });

  it('keeps the explicit legacy fallback for non-Claude/Codex modes', async () => {
    const shell = new Session({ workingDir: '/tmp', mode: 'shell' });
    expect(shell.getCheckpointObservation()).toMatchObject({ ready: true, working: false });
    await shell.stop();
  });

  it('uses only hook-adopted Claude identity for generation observation', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    installFrame(session, () => '❯ prompt');
    const observe = () =>
      (
        session as unknown as {
          getCheckpointAutomationObservation(): Promise<{ conversationId?: string }>;
        }
      ).getCheckpointAutomationObservation();

    await expect(observe()).resolves.toMatchObject({ conversationId: undefined });
    session.adoptClaudeSessionStartId('claude-session-start-id');
    await expect(observe()).resolves.toMatchObject({ conversationId: 'claude-session-start-id' });
    await session.stop();
  });

  it('runs a Claude new handoff with only /new and preserves it through hook adoption', async () => {
    vi.useFakeTimers();
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      claudeSessionStartHookReady: true,
    });
    const sent: string[] = [];
    const internals = session as unknown as {
      _mux: {
        captureActivePaneBuffer: () => string;
        sendCheckpointCommand: (_muxName: string, command: string) => Promise<{ ok: true; attempt: number }>;
      };
      _muxSession: { muxName: string };
    };
    internals._mux = {
      captureActivePaneBuffer: () => '❯ prompt',
      sendCheckpointCommand: async (_muxName, command) => {
        sent.push(command);
        return { ok: true, attempt: 1 };
      },
    };
    internals._muxSession = { muxName: 'codeman-abc12345' };
    session.adoptClaudeSessionStartId('claude-before-new');
    session.setCheckpoint(true, ['new']);

    expect(session.requestCheckpoint({ mode: 'new' })).toEqual({ triggered: true, runId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(['/new\r']);
    session.adoptClaudeSessionStartId('claude-after-new');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(['/new\r', 'continue\r']);
    expect(sent).not.toContain('/clear\r');

    await session.stop();
    vi.useRealTimers();
  });

  it('rejects checkpoint orchestration for an unsupported Session backend', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    session.setCheckpoint(true, ['new']);
    expect(session.requestCheckpoint({ mode: 'new' })).toEqual({
      triggered: false,
      reason: 'unsupported-backend',
    });
    await session.stop();
  });

  it('fails restored Claude fresh-thread checkpoints when SessionStart hook capability is unavailable', async () => {
    const session = new Session({
      workingDir: '/remote/project',
      mode: 'claude',
      claudeSessionStartHookReady: false,
    });
    session.setCheckpoint(true, ['new']);
    expect(session.requestCheckpoint({ mode: 'new' })).toEqual({
      triggered: false,
      reason: 'session-start-hook-unavailable',
    });
    session.setCheckpoint(true, ['compact']);
    expect(session.requestCheckpoint({ mode: 'compact' })).toEqual({ triggered: true, runId: expect.any(String) });
    session.cancelCheckpoint('test-cleanup');
    await session.stop();
  });

  it('defaults new Claude sessions to fail-closed fresh-thread capability unless explicitly proven', async () => {
    const session = new Session({ workingDir: '/arbitrary/project', mode: 'claude' });
    session.setCheckpoint(true, ['clear']);
    expect(session.requestCheckpoint({ mode: 'clear' })).toEqual({
      triggered: false,
      reason: 'session-start-hook-unavailable',
    });
    await session.stop();
  });

  it('rejects remote Codex fresh-thread modes while leaving compact available', async () => {
    const session = new Session({
      workingDir: '/remote/project',
      mode: 'codex',
      remote: { hostId: 'r1', label: 'r1', host: 'host', username: 'user', remotePath: '/remote/project' },
    });
    session.setCheckpoint(true, ['new', 'compact']);
    expect(session.requestCheckpoint({ mode: 'new' })).toEqual({
      triggered: false,
      reason: 'remote-identity-unavailable',
    });
    expect(session.requestCheckpoint({ mode: 'compact' })).toEqual({ triggered: true, runId: expect.any(String) });
    session.cancelCheckpoint('test-cleanup');
    await session.stop();
  });

  it('restores only an explicitly adopted Claude identity and becomes ready after SessionStart adoption', async () => {
    const legacy = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      claudeSessionStartHookReady: true,
      claudeSessionId: 'placeholder-id',
      claudeSessionIdentityAdopted: false,
    });
    legacy.setCheckpoint(true, ['new']);
    expect(legacy.requestCheckpoint({ mode: 'new' })).toMatchObject({ triggered: false });
    legacy.adoptClaudeSessionStartId('authoritative-id');
    expect(legacy.toState()).toMatchObject({
      claudeSessionId: 'authoritative-id',
      claudeSessionIdentityAdopted: true,
    });
    expect(legacy.requestCheckpoint({ mode: 'new' })).toEqual({ triggered: true, runId: expect.any(String) });
    legacy.cancelCheckpoint('test-cleanup');
    await legacy.stop();
  });

  it('round-trips an authoritative Claude identity across restart recovery', async () => {
    const original = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      claudeSessionStartHookReady: true,
    });
    original.adoptClaudeSessionStartId('persisted-authoritative-id');
    original.adoptClaudeSessionId('viewer-only-id');
    const saved = original.toState();
    expect(saved.claudeSessionId).toBe('persisted-authoritative-id');
    await expect(
      (
        original as unknown as {
          getCheckpointAutomationObservation(): Promise<{ conversationId?: string }>;
        }
      ).getCheckpointAutomationObservation()
    ).resolves.toMatchObject({ conversationId: 'persisted-authoritative-id' });
    const restored = new Session({
      id: saved.id,
      workingDir: saved.workingDir,
      mode: 'claude',
      claudeSessionStartHookReady: true,
      claudeSessionId: saved.claudeSessionId,
      claudeSessionIdentityAdopted: saved.claudeSessionIdentityAdopted,
    });
    (
      restored as unknown as {
        _seedClaudeViewerIdentityAfterMuxAttach(isRestored: boolean): void;
      }
    )._seedClaudeViewerIdentityAfterMuxAttach(true);
    expect(restored.toState().claudeSessionId).toBe('persisted-authoritative-id');
    restored.setCheckpoint(true, ['new']);
    expect(restored.requestCheckpoint({ mode: 'new' })).toEqual({
      triggered: true,
      runId: expect.any(String),
    });
    restored.cancelCheckpoint('test-cleanup');
    await original.stop();
    await restored.stop();
  });

  it('serializes the durable terminal checkpoint record', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const internals = session as unknown as {
      _mux: {
        captureActivePaneBuffer: () => string;
        sendCheckpointCommand: () => Promise<{ ok: false; stage: 'text'; attempt: number }>;
      };
      _muxSession: { muxName: string };
    };
    internals._mux = {
      captureActivePaneBuffer: () => '› prompt',
      sendCheckpointCommand: async () => ({ ok: false, stage: 'text', attempt: 2 }),
    };
    internals._muxSession = { muxName: 'codeman-abc12345' };
    session.setCheckpoint(true, ['compact']);
    session.requestCheckpoint();

    await vi.waitFor(() => {
      expect(session.toState().checkpoint).toMatchObject({
        active: false,
        mode: 'compact',
        phase: 'failed',
        step: 'compact',
        reason: 'delivery-failed',
        stage: 'text',
      });
    });
    await session.stop();
  });

  it('restores an active persisted checkpoint as safely aborted instead of resuming it', async () => {
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      checkpointState: {
        active: true,
        mode: 'clear',
        phase: 'operation-started',
        step: 'clear',
        updatedAt: 100,
      },
    });

    expect(session.toState().checkpoint).toMatchObject({
      active: false,
      mode: 'clear',
      phase: 'aborted',
      step: 'clear',
      reason: 'restarted',
    });
    await session.stop();

    const completed = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      checkpointState: {
        active: false,
        mode: 'compact',
        phase: 'done',
        updatedAt: 200,
      },
    });
    expect(completed.toState().checkpoint).toEqual({
      active: false,
      runId: 'legacy-200',
      status: 'completed',
      mode: 'compact',
      phase: 'done',
      updatedAt: 200,
    });
    await completed.stop();
  });

  it('restores bounded run-keyed history and cancels every active run as restarted without prompt data', async () => {
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      checkpointState: {
        active: true,
        runId: 'active-run',
        status: 'running',
        mode: 'new',
        phase: 'waiting-ready',
        step: 'new',
        updatedAt: 10,
      },
      checkpointRuns: {
        'done-run': {
          active: false,
          runId: 'done-run',
          status: 'completed',
          mode: 'compact',
          phase: 'done',
          updatedAt: 5,
        },
        'active-run': {
          active: true,
          runId: 'active-run',
          status: 'running',
          mode: 'new',
          phase: 'waiting-ready',
          step: 'new',
          updatedAt: 10,
        },
      },
    });
    expect(session.toState().checkpointRuns).toMatchObject({
      'done-run': { status: 'completed' },
      'active-run': { active: false, status: 'cancelled', reason: 'restarted' },
    });
    expect(JSON.stringify(session.toState().checkpointRuns)).not.toContain('continuePrompt');
    await session.stop();
  });
});

describe('Codex idle transition (COD-175)', () => {
  let session: Session;
  let frame: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({ workingDir: '/tmp', mode: 'codex' });
    frame = null;
    const internals = session as unknown as { _mux: unknown; _muxSession: unknown };
    internals._mux = { captureActivePaneBuffer: vi.fn(() => frame) };
    internals._muxSession = { muxName: 'codeman-test1234' };
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  function feed(data: string): void {
    (session as unknown as { _detectInteractiveActivity(data: string): void })._detectInteractiveActivity(data);
  }

  it('clears isWorking when the rendered composer confirms turn end', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    feed('• Working (2s • esc to interrupt)');
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');

    // frames keep ticking — idle timer keeps re-arming
    vi.advanceTimersByTime(1000);
    feed('• Working (3s • esc to interrupt)');
    vi.advanceTimersByTime(4000);
    expect(session.isWorking).toBe(true);
    expect(idleEvents.length).toBe(0);

    // A rendered composer positively confirms the turn ended.
    frame = '› Type your next prompt';
    vi.advanceTimersByTime(6000);
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents.length).toBe(1);
    expect(idleEvents[0]).toEqual({ reason: 'turn-end' });
  });

  it('clears stale working state before labeling a restarted CLI as initially ready', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));
    const internals = session as unknown as {
      _resetBuffers(): void;
      _armExternalCliIdleTimer(): void;
    };

    feed('• Working (2s • esc to interrupt)');
    expect(session.isWorking).toBe(true);

    internals._resetBuffers();
    expect(session.isWorking).toBe(false);
    internals._armExternalCliIdleTimer();
    vi.advanceTimersByTime(6_000);

    expect(idleEvents).toEqual([{ reason: 'initial-ready' }]);
  });

  it('re-enters working on the next turn after going idle', () => {
    feed('• Working (2s • esc to interrupt)');
    frame = '› Type your next prompt';
    vi.advanceTimersByTime(10_000);
    expect(session.isWorking).toBe(false);

    feed('• Working (1s • esc to interrupt)');
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
  });

  it('does not arm the codex idle timer for claude mode', () => {
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    (claude as unknown as { _detectInteractiveActivity(data: string): void })._detectInteractiveActivity('⠋ Thinking…');
    expect(claude.isWorking).toBe(true);
    // codex quiet-window elapses — claude sessions must NOT flip to idle from this path
    vi.advanceTimersByTime(20_000);
    expect(claude.isWorking).toBe(true);
    return claude.stop();
  });

  it('keeps non-Codex external CLI quiet-window behavior unchanged', async () => {
    const opencode = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const idleEvents: Array<{ reason?: string }> = [];
    opencode.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    (opencode as unknown as { _detectInteractiveActivity(data: string): void })._detectInteractiveActivity('Working');
    expect(opencode.isWorking).toBe(true);

    vi.advanceTimersByTime(6_000);

    expect(opencode.isWorking).toBe(false);
    expect(opencode.status).toBe('idle');
    expect(idleEvents).toEqual([{ reason: 'turn-end' }]);
    await opencode.stop();
  });
});

describe('COD-181 remote working-frame poller', () => {
  let session: Session;
  let frame: string | null;

  const WORKING_FRAME =
    '\x1b[1m•\x1b[0m \x1b[1mWorking\x1b[0m (3m 12s • esc to interrupt) · 1 background terminal running\r\n' +
    '\x1b[1m›\x1b[0m type your message\r\n';
  const IDLE_FRAME = '• Done.\r\n\x1b[1m›\x1b[0m Summarize recent commits\r\n  gpt-5.5 medium · /tmp\r\n';

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      remote: { hostId: 'mac-mini', label: 'mac-mini', host: '10.0.0.9', username: 'u', remotePath: '/tmp' },
    });
    frame = IDLE_FRAME;
    const s = session as unknown as {
      _mux: unknown;
      _muxSession: unknown;
      _startWorkingFramePoller(): void;
    };
    s._mux = { captureActivePaneBuffer: vi.fn(() => frame), killSession: vi.fn(async () => false) };
    s._muxSession = { muxName: 'codeman-test1234' };
    s._startWorkingFramePoller();
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  it('flips to busy from a rendered Working frame (SGR escapes inside the line)', () => {
    const workingEvents: number[] = [];
    session.on('working', () => workingEvents.push(Date.now()));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100); // one poll tick
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(workingEvents.length).toBe(1);
  });

  it('stays busy while the frame keeps showing Working (polls re-arm the quiet window)', () => {
    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    expect(session.isWorking).toBe(true);
    // 30 more seconds of a long turn — well past the 5s quiet window, but each
    // 2s poll sees the Working line and re-arms it.
    vi.advanceTimersByTime(30_000);
    expect(session.isWorking).toBe(true);
  });

  it('flips to idle via the quiet window once the Working line disappears', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(4_200);
    expect(session.isWorking).toBe(true);

    frame = IDLE_FRAME;
    vi.advanceTimersByTime(7_000); // > EXTERNAL_CLI_IDLE_DELAY_MS with no positive polls
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents.length).toBe(1);
    expect(idleEvents[0]).toEqual({ reason: 'turn-end' });
  });

  it('stays busy across quiet windows while the current Codex layout still says Working', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = '• Working (31)\n› retained prompt';

    vi.advanceTimersByTime(20_000);

    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);
  });

  it('stays busy across quiet windows when the rendered state is unknown', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = 'tool output with no current Codex UI';

    vi.advanceTimersByTime(20_000);

    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);
  });

  it('stays busy across quiet windows when pane capture is unavailable', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = null;

    vi.advanceTimersByTime(20_000);

    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);
  });

  it('emits exactly one turn-end idle for a rendered composer', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = '› Type your next prompt';

    vi.advanceTimersByTime(20_000);

    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents).toEqual([{ reason: 'turn-end' }]);
  });

  it('emits exactly one turn-end idle for a rendered numbered-choice dialog', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = 'Allow this command?\n  1. Yes\n❯ 2. No';

    vi.advanceTimersByTime(20_000);

    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents).toEqual([{ reason: 'turn-end' }]);
  });

  it('lets working evidence override a retained composer at the timer boundary', () => {
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(2_100);
    frame = '• Working (31)\n› retained prompt';

    vi.advanceTimersByTime(5_100);

    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);
  });

  it('never flips busy from an idle frame', () => {
    frame = IDLE_FRAME;
    vi.advanceTimersByTime(20_000);
    expect(session.isWorking).toBe(false);
  });
});
