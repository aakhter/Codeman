import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectExternalCliWorkingFrame, Session } from '../src/session.js';
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
      _detectWorkingState(data: string): void;
    };
    internals.ptyProcess = { write: vi.fn() };
    internals._lastPromptTime = 1;
    internals._status = 'idle';
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    internals._detectWorkingState('\x1b[2J\x1b[Hfresh Claude prompt\n❯');

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
      _detectWorkingState(data: string): void;
    };
    internals.ptyProcess = { write: vi.fn() };
    internals._lastPromptTime = 1;
    internals._status = 'idle';
    const baseline = session.getCheckpointObservation();

    await session.writeCheckpointViaMux('/clear\r');
    internals._detectWorkingState('Error: unknown command /clear\n❯');

    expect(session.getCheckpointObservation()).toEqual(baseline);
    await session.stop();
  });

  it('keeps the explicit legacy fallback for non-Claude/Codex modes', async () => {
    const shell = new Session({ workingDir: '/tmp', mode: 'shell' });
    expect(shell.getCheckpointObservation()).toMatchObject({ ready: true, working: false });
    await shell.stop();
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
});

describe('Codex idle transition (COD-175)', () => {
  let session: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({ workingDir: '/tmp', mode: 'codex' });
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  function feed(data: string): void {
    (session as unknown as { _detectWorkingState(data: string): void })._detectWorkingState(data);
  }

  it('clears isWorking and emits idle after working frames stop', () => {
    const idleEvents: number[] = [];
    session.on('idle', () => idleEvents.push(Date.now()));

    feed('• Working (2s • esc to interrupt)');
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');

    // frames keep ticking — idle timer keeps re-arming
    vi.advanceTimersByTime(1000);
    feed('• Working (3s • esc to interrupt)');
    vi.advanceTimersByTime(4000);
    expect(session.isWorking).toBe(true);
    expect(idleEvents.length).toBe(0);

    // frames stop → idle after the quiet window
    vi.advanceTimersByTime(6000);
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents.length).toBe(1);
  });

  it('re-enters working on the next turn after going idle', () => {
    feed('• Working (2s • esc to interrupt)');
    vi.advanceTimersByTime(10_000);
    expect(session.isWorking).toBe(false);

    feed('• Working (1s • esc to interrupt)');
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
  });

  it('does not arm the codex idle timer for claude mode', () => {
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' });
    (claude as unknown as { _detectWorkingState(data: string): void })._detectWorkingState('⠋ Thinking…');
    expect(claude.isWorking).toBe(true);
    // codex quiet-window elapses — claude sessions must NOT flip to idle from this path
    vi.advanceTimersByTime(20_000);
    expect(claude.isWorking).toBe(true);
    return claude.stop();
  });
});

describe('COD-181 remote working-frame poller', () => {
  let session: Session;
  let frame: string;

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
    s._mux = { captureActivePaneBuffer: vi.fn(() => frame) };
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
    const idleEvents: number[] = [];
    session.on('idle', () => idleEvents.push(Date.now()));

    frame = WORKING_FRAME;
    vi.advanceTimersByTime(4_200);
    expect(session.isWorking).toBe(true);

    frame = IDLE_FRAME;
    vi.advanceTimersByTime(7_000); // > EXTERNAL_CLI_IDLE_DELAY_MS with no positive polls
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents.length).toBe(1);
  });

  it('never flips busy from an idle frame', () => {
    frame = IDLE_FRAME;
    vi.advanceTimersByTime(20_000);
    expect(session.isWorking).toBe(false);
  });
});
