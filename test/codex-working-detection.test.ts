import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectExternalCliWorkingFrame, Session } from '../src/session.js';

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
