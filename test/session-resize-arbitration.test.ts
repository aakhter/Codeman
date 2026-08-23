import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void; kill: () => void };
  _ptyCols: number;
  _ptyRows: number;
};

type SizingLifecycleInternals = {
  _mux: { killSession: () => Promise<boolean> } | null;
  _respawnBlocked: boolean;
  _applyNativeResumeIdForResume: () => void;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize, kill: vi.fn() };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

describe('Session resize ownership', () => {
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

  it('suspends sizing throughout delayed park teardown and re-enables it at interactive resume', async () => {
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

    lifecycle._applyNativeResumeIdForResume = () => {
      throw new Error('resume-boundary-sentinel');
    };
    await expect(session.startInteractive()).rejects.toThrow('resume-boundary-sentinel');

    const resize = attachFakePty(session, 120, 40);
    expect(session.resizeFromTerminalViewer(resumed, 160, 48, 'desktop')).toBe(false);
    expect(session.bootstrapTerminalViewer(resumed)).toBe(true);
    expect(session.resizeFromTerminalViewer(stale, 70, 50, 'mobile')).toBe(false);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(160, 48);
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

    lifecycle._applyNativeResumeIdForResume = () => {
      throw new Error('stopped-start-sentinel');
    };
    await expect(session.startInteractive()).rejects.toThrow('stopped-start-sentinel');

    const resize = attachFakePty(session, 120, 40);
    expect(session.bootstrapTerminalViewer(restarted)).toBe(false);
    expect(resize).not.toHaveBeenCalled();
  });
});
