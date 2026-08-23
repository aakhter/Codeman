import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void; kill: () => void };
  _ptyCols: number;
  _ptyRows: number;
};

type ResizeCompletion = (success: boolean) => void;

type SizingLifecycleInternals = {
  _mux: { killSession: () => Promise<boolean> } | null;
  _respawnBlocked: boolean;
  _suspendTerminalViewerSizing: () => void;
  _resumeTerminalViewerSizing: () => void;
};

type InteractiveExit = (event: { exitCode: number }) => void;

type InteractiveStartInternals = {
  _mux: { backend: string; setAttached: (id: string, attached: boolean) => void } | null;
  _useMux: boolean;
  _setupOrAttachMuxSession: () => Promise<{ isRestored: boolean }>;
  ptyProcess: {
    pid: number;
    resize: (cols: number, rows: number) => void;
    write: (data: string) => void;
    kill: () => void;
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: InteractiveExit) => void;
  } | null;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize, kill: vi.fn() };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

function sessionWithAuthoritativeResize(cols = 160, rows = 48) {
  const completions: ResizeCompletion[] = [];
  const resizeWindow = vi.fn(
    (_muxName: string, _cols: number, _rows: number, onComplete?: ResizeCompletion): boolean => {
      if (onComplete) completions.push(onComplete);
      return true;
    }
  );
  const session = new Session({
    workingDir: '/tmp',
    mode: 'opencode',
    mux: { isAvailable: () => true, resizeWindow },
    muxSession: { muxName: 'codeman-resize', sessionId: 'resize', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
  attachFakePty(session, cols, rows);
  return { session, resizeWindow, completions };
}

function prepareSuccessfulInteractiveStart(session: Session) {
  const resize = vi.fn();
  let onExit: InteractiveExit | null = null;
  let finishSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  const internals = session as unknown as InteractiveStartInternals;
  internals._mux = { backend: 'test', setAttached: vi.fn() };
  internals._useMux = true;
  internals._setupOrAttachMuxSession = vi.fn(async () => {
    await setupGate;
    internals.ptyProcess = {
      pid: 1234,
      resize,
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((callback: InteractiveExit) => {
        onExit = callback;
      }),
    };
    return { isRestored: true };
  });
  return {
    resize,
    setup: internals._setupOrAttachMuxSession,
    finishSetup,
    exit(exitCode: number) {
      if (!onExit) throw new Error('interactive exit handler was not registered');
      onExit({ exitCode });
    },
  };
}

describe('Session resize ownership', () => {
  it('keeps a failed authoritative target retryable and confirms only the successful retry', () => {
    const { session, resizeWindow, completions } = sessionWithAuthoritativeResize(140, 44);
    const phone = Symbol('phone');
    const seen: Array<{ cols: number; rows: number }> = [];
    session.on('resized', (dimensions) => seen.push(dimensions));

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    expect(resizeWindow).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);

    completions.shift()!(false);
    expect(seen).toEqual([]);
    expect(session.resizeFromTerminalViewer(phone, 75, 62, 'mobile')).toBe(true);
    expect(resizeWindow).toHaveBeenCalledTimes(2);

    completions.shift()!(true);
    expect(seen).toEqual([{ cols: 75, rows: 62 }]);
  });

  it('does not confirm a successful resize after its viewer ownership generation is stale', () => {
    const { session, resizeWindow, completions } = sessionWithAuthoritativeResize(140, 44);
    const phone = Symbol('phone');
    const desktop = Symbol('desktop');
    const seen: Array<{ cols: number; rows: number }> = [];
    session.on('resized', (dimensions) => seen.push(dimensions));

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    expect(resizeWindow).toHaveBeenCalledTimes(1);

    session.activateTerminalViewer(desktop);
    completions.shift()!(true);

    expect(seen).toEqual([]);
    expect((session as unknown as ResizeableSessionInternals)._ptyCols).toBe(140);
    expect((session as unknown as ResizeableSessionInternals)._ptyRows).toBe(44);
  });

  it('reconciles confirmed dimensions after a dimensionless ownership transfer makes completion stale', () => {
    const { session, resizeWindow, completions } = sessionWithAuthoritativeResize(140, 44);
    const phone = Symbol('phone');
    const desktop = Symbol('desktop');

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    session.activateTerminalViewer(desktop);
    completions.shift()!(true);

    session.activateTerminalViewer(desktop, { cols: 140, rows: 44, viewportType: 'desktop' });

    expect(resizeWindow).toHaveBeenCalledTimes(2);
    expect(resizeWindow).toHaveBeenLastCalledWith('codeman-resize', 140, 44, expect.any(Function));
  });

  it('reconciles confirmed dimensions after release makes an in-flight completion stale', () => {
    const { session, resizeWindow, completions } = sessionWithAuthoritativeResize(140, 44);
    const phone = Symbol('phone');
    const desktop = Symbol('desktop');

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    session.releaseTerminalViewer(phone);
    completions.shift()!(true);

    session.activateTerminalViewer(desktop, { cols: 140, rows: 44, viewportType: 'desktop' });

    expect(resizeWindow).toHaveBeenCalledTimes(2);
    expect(resizeWindow).toHaveBeenLastCalledWith('codeman-resize', 140, 44, expect.any(Function));
  });

  it('reconciles confirmed dimensions after lifecycle suspension invalidates an in-flight completion', () => {
    const { session, resizeWindow, completions } = sessionWithAuthoritativeResize(140, 44);
    const phone = Symbol('phone');
    const desktop = Symbol('desktop');
    const lifecycle = session as unknown as SizingLifecycleInternals;

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    lifecycle._suspendTerminalViewerSizing();
    completions.shift()!(true);
    lifecycle._resumeTerminalViewerSizing();

    session.activateTerminalViewer(desktop, { cols: 140, rows: 44, viewportType: 'desktop' });

    expect(resizeWindow).toHaveBeenCalledTimes(2);
    expect(resizeWindow).toHaveBeenLastCalledWith('codeman-resize', 140, 44, expect.any(Function));
  });

  it('immediately hands an idle connected desktop pane to an explicitly active phone', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const resize = attachFakePty(session, 140, 44);
    const desktop = Symbol('desktop');
    const phone = Symbol('phone');

    session.rememberTerminalViewerSize(desktop, 140, 44, 'desktop');
    session.activateTerminalViewer(desktop);
    session.rememberTerminalViewerSize(phone, 75, 62, 'mobile');
    const generation = session.activateTerminalViewer(phone);

    expect(generation).toBe(2);
    expect(resize).toHaveBeenLastCalledWith(75, 62);
  });

  it('remembers a passive desktop resize and immediately restores it on explicit activation', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const resize = attachFakePty(session, 140, 44);
    const desktop = Symbol('desktop');
    const phone = Symbol('phone');

    session.rememberTerminalViewerSize(desktop, 140, 44, 'desktop');
    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    resize.mockClear();

    expect(session.resizeFromTerminalViewer(desktop, 160, 48, 'desktop')).toBe(false);
    expect(resize).not.toHaveBeenCalled();

    expect(session.activateTerminalViewer(desktop)).toBe(2);
    expect(resize).toHaveBeenCalledWith(160, 48);
  });

  it('keeps the owner after passive release and requires activation after owner release', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const resize = attachFakePty(session, 140, 44);
    const desktop = Symbol('desktop');
    const phone = Symbol('phone');

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    session.rememberTerminalViewerSize(desktop, 160, 48, 'desktop');
    resize.mockClear();

    session.releaseTerminalViewer(desktop);
    expect(session.resizeFromTerminalViewer(phone, 80, 60, 'mobile')).toBe(true);
    expect(resize).toHaveBeenLastCalledWith(80, 60);

    session.releaseTerminalViewer(phone);
    expect(session.resizeFromTerminalViewer(phone, 82, 58, 'mobile')).toBe(false);
    expect(resize).toHaveBeenCalledTimes(1);

    session.activateTerminalViewer(phone);
    expect(resize).toHaveBeenLastCalledWith(82, 58);
  });

  it('keeps low-level resize as a trusted path without viewer ownership', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });
    session.resize(100, 30);

    expect(resize).toHaveBeenNthCalledWith(1, 48, 28);
    expect(resize).toHaveBeenNthCalledWith(2, 100, 30);
  });

  it('admits trusted initializer resize only while terminal sizing has no active viewer', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const viewer = Symbol('viewer');

    session.activateTerminalViewer(viewer, { cols: 140, rows: 44, viewportType: 'desktop' });
    resize.mockClear();

    expect(session.resizeIfNoActiveTerminalViewer(75, 62)).toBe(false);
    expect(resize).not.toHaveBeenCalled();

    session.releaseTerminalViewer(viewer);
    expect(session.resizeIfNoActiveTerminalViewer(75, 62)).toBe(true);
    expect(resize).toHaveBeenCalledWith(75, 62);
  });

  it('forwards force from the owning viewer for a same-size resize', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 120, 40);
    const viewer = Symbol('viewer');

    session.activateTerminalViewer(viewer, { cols: 120, rows: 40, viewportType: 'desktop' });
    expect(resize).not.toHaveBeenCalled();

    expect(session.resizeFromTerminalViewer(viewer, 120, 40, 'desktop', true)).toBe(true);
    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('bootstraps an ownerless remembered viewer once and forwards force', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 120, 40);
    const viewer = Symbol('viewer');

    expect(session.resizeFromTerminalViewer(viewer, 120, 40, 'desktop', true)).toBe(false);
    expect(session.bootstrapTerminalViewer(viewer, true)).toBe(true);

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('does not let a passive viewer bootstrap over an existing owner', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const resize = attachFakePty(session, 140, 44);
    const phone = Symbol('phone');
    const desktop = Symbol('desktop');

    session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });
    resize.mockClear();

    expect(session.resizeFromTerminalViewer(desktop, 160, 48, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(desktop)).toBe(false);
    expect(session.resizeFromTerminalViewer(phone, 80, 60, 'mobile')).toBe(true);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(80, 60);
  });

  it('keeps sizing suspended throughout delayed park teardown and a failed interactive resume', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const stale = Symbol('stale');
    const resumed = Symbol('resumed');
    let finishMuxTeardown!: (value: boolean) => void;
    const muxTeardown = new Promise<boolean>((resolve) => {
      finishMuxTeardown = resolve;
    });
    const lifecycle = session as unknown as SizingLifecycleInternals;
    lifecycle._mux = { killSession: vi.fn(() => muxTeardown) };

    attachFakePty(session, 140, 44);
    session.activateTerminalViewer(stale, { cols: 75, rows: 62, viewportType: 'mobile' });
    const parking = session.park();

    const gatedGeneration = session.activateTerminalViewer(stale, {
      cols: 70,
      rows: 50,
      viewportType: 'mobile',
    });
    expect(session.resizeFromTerminalViewer(stale, 68, 48, 'mobile')).toBe(false);
    expect(session.bootstrapTerminalViewer(stale)).toBe(false);
    expect(session.activateTerminalViewer(resumed, { cols: 160, rows: 48, viewportType: 'desktop' })).toBe(
      gatedGeneration
    );

    finishMuxTeardown(true);
    await parking;
    expect(session.bootstrapTerminalViewer(stale)).toBe(false);

    await expect(session.startInteractive()).rejects.toThrow('OpenCode sessions require tmux');

    const resize = attachFakePty(session, 120, 40);
    expect(session.resizeFromTerminalViewer(resumed, 160, 48, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(resumed)).toBe(false);
    expect(session.resizeFromTerminalViewer(stale, 70, 50, 'mobile')).toBe(false);

    expect(resize).not.toHaveBeenCalled();
  });

  it('resumes sizing only after a successful interactive start', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const viewer = Symbol('viewer');

    await session.park();
    const start = prepareSuccessfulInteractiveStart(session);

    const starting = session.startInteractive();
    await vi.waitFor(() => expect(start.setup).toHaveBeenCalledTimes(1));
    expect(session.resizeFromTerminalViewer(viewer, 70, 25, 'tablet')).toBe(false);
    expect(session.bootstrapTerminalViewer(viewer)).toBe(false);

    start.finishSetup();
    await starting;
    session.activateTerminalViewer(viewer, { cols: 80, rows: 30, viewportType: 'tablet' });

    expect(start.resize).toHaveBeenCalledWith(80, 30);
  });

  it('suspends and clears viewer sizing when the interactive PTY exits', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const active = Symbol('active');
    const afterExit = Symbol('after-exit');

    await session.park();
    const start = prepareSuccessfulInteractiveStart(session);
    const starting = session.startInteractive();
    await vi.waitFor(() => expect(start.setup).toHaveBeenCalledTimes(1));
    start.finishSetup();
    await starting;
    session.activateTerminalViewer(active, { cols: 80, rows: 30, viewportType: 'tablet' });
    start.resize.mockClear();

    start.exit(0);
    session.activateTerminalViewer(afterExit, { cols: 100, rows: 35, viewportType: 'desktop' });

    expect(session.resizeFromTerminalViewer(afterExit, 110, 36, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(afterExit)).toBe(false);
    expect(start.resize).not.toHaveBeenCalled();
  });

  it('does not re-enable sizing when interactive resume fails its respawn guard', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const lifecycle = session as unknown as SizingLifecycleInternals;
    const viewer = Symbol('viewer');

    await session.park();
    lifecycle._respawnBlocked = true;

    await expect(session.startInteractive()).rejects.toThrow('Respawn blocked');
    expect(session.resizeFromTerminalViewer(viewer, 160, 48, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(viewer)).toBe(false);
  });

  it('keeps sizing terminally suspended during and after stop', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const stale = Symbol('stale');
    const restarted = Symbol('restarted');
    const lifecycle = session as unknown as SizingLifecycleInternals;

    attachFakePty(session, 140, 44);
    session.activateTerminalViewer(stale, { cols: 75, rows: 62, viewportType: 'mobile' });
    const stopping = session.stop(false);

    expect(session.resizeFromTerminalViewer(stale, 70, 50, 'mobile')).toBe(false);
    expect(session.bootstrapTerminalViewer(stale)).toBe(false);
    await stopping;

    expect(session.resizeFromTerminalViewer(restarted, 160, 48, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(restarted)).toBe(false);
    expect(session.resizeFromTerminalViewer(stale, 70, 50, 'mobile')).toBe(false);

    (lifecycle as unknown as { _applyNativeResumeIdForResume: () => void })._applyNativeResumeIdForResume = () => {
      throw new Error('stopped-start-sentinel');
    };
    await expect(session.startInteractive()).rejects.toThrow('stopped-start-sentinel');

    const resize = attachFakePty(session, 120, 40);
    expect(session.bootstrapTerminalViewer(restarted)).toBe(false);
    expect(resize).not.toHaveBeenCalled();
  });
});
