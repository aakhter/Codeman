import { describe, expect, it } from 'vitest';
import { TerminalSizingOwnership } from '../src/terminal-sizing-ownership.js';

const desktop = Symbol('desktop');
const mobile = Symbol('mobile');
const desktopDims = { cols: 140, rows: 44, viewportType: 'desktop' as const };
const mobileDims = { cols: 75, rows: 62, viewportType: 'mobile' as const };

describe('TerminalSizingOwnership', () => {
  it('lets the latest explicit activation own sizing while retaining every viewer dimensions', () => {
    const ownership = new TerminalSizingOwnership();

    ownership.remember(desktop, desktopDims);
    const desktopActivation = ownership.activate(desktop);
    ownership.remember(mobile, mobileDims);
    const mobileActivation = ownership.activate(mobile);

    expect(desktopActivation).toEqual({ generation: 1, changedOwner: true, dimensions: desktopDims });
    expect(mobileActivation).toEqual({ generation: 2, changedOwner: true, dimensions: mobileDims });
    expect(ownership.ownerToken).toBe(mobile);
    expect(ownership.isOwner(mobile)).toBe(true);
    expect(ownership.dimensionsFor(desktop)).toEqual(desktopDims);
    expect(ownership.dimensionsFor(mobile)).toEqual(mobileDims);
  });

  it('only clears ownership when the current connection token is released', () => {
    const ownership = new TerminalSizingOwnership();

    ownership.activate(desktop, desktopDims);
    ownership.activate(mobile, mobileDims);
    ownership.release(desktop);

    expect(ownership.ownerToken).toBe(mobile);
    expect(ownership.isOwner(mobile)).toBe(true);
    expect(ownership.dimensionsFor(desktop)).toBeNull();

    ownership.release(mobile);

    expect(ownership.ownerToken).toBeNull();
    expect(ownership.dimensionsFor(mobile)).toBeNull();
    expect(ownership.activate(desktop).generation).toBe(4);
  });

  it('leaves the generation unchanged when the current owner reactivates', () => {
    const ownership = new TerminalSizingOwnership();

    const first = ownership.activate(desktop, desktopDims);
    const second = ownership.activate(desktop);

    expect(first.generation).toBe(1);
    expect(second).toEqual({ generation: 1, changedOwner: false, dimensions: desktopDims });
  });

  it('accepts remembered dimensions before or during activation', () => {
    const ownership = new TerminalSizingOwnership();

    ownership.remember(desktop, desktopDims);
    const rememberedActivation = ownership.activate(desktop);
    const suppliedActivation = ownership.activate(mobile, mobileDims);

    expect(rememberedActivation.dimensions).toEqual(desktopDims);
    expect(suppliedActivation.dimensions).toEqual(mobileDims);
    expect(ownership.dimensionsFor(mobile)).toEqual(mobileDims);
  });

  it('bootstraps only while ownership is empty', () => {
    const ownership = new TerminalSizingOwnership();

    expect(ownership.bootstrap(mobile)).toBeNull();
    expect(ownership.ownerToken).toBeNull();

    ownership.remember(desktop, desktopDims);
    const bootstrap = ownership.bootstrap(desktop);
    ownership.remember(mobile, mobileDims);

    expect(bootstrap).toEqual({ generation: 1, changedOwner: true, dimensions: desktopDims });
    expect(ownership.bootstrap(mobile)).toBeNull();
    expect(ownership.ownerToken).toBe(desktop);
  });

  it('clears all dimensions and invalidates an existing owner generation once', () => {
    const ownership = new TerminalSizingOwnership();

    ownership.activate(desktop, desktopDims);
    ownership.remember(mobile, mobileDims);
    ownership.clear();

    expect(ownership.currentGeneration).toBe(2);
    expect(ownership.ownerToken).toBeNull();
    expect(ownership.dimensionsFor(desktop)).toBeNull();
    expect(ownership.dimensionsFor(mobile)).toBeNull();
    expect(ownership.activate(mobile, mobileDims).generation).toBe(3);

    ownership.release(mobile);
    ownership.clear();
    expect(ownership.activate(desktop, desktopDims).generation).toBe(5);
  });

  it('keeps immutable snapshots of supplied and returned dimensions', () => {
    const ownership = new TerminalSizingOwnership();
    const supplied = { cols: 140, rows: 44, viewportType: 'desktop' as const };

    ownership.remember(desktop, supplied);
    (supplied as { cols: number }).cols = 999;
    const returned = ownership.dimensionsFor(desktop);
    (returned as { rows: number }).rows = 999;

    const activation = ownership.activate(desktop);
    (activation.dimensions as { viewportType: 'mobile' }).viewportType = 'mobile';

    expect(ownership.dimensionsFor(desktop)).toEqual(desktopDims);
  });
});
