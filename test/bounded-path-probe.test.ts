import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  default: { stat: vi.fn() },
}));

import fs from 'node:fs/promises';
import { boundedPathExists } from '../src/utils/bounded-path-probe.js';

const stat = vi.mocked(fs.stat);

afterEach(() => {
  vi.useRealTimers();
  stat.mockReset();
});

describe('boundedPathExists', () => {
  it('returns promptly when an NFS stat never completes and does not repeat that probe', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    stat.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({} as never);
        })
    );

    const result = boundedPathExists('/mnt/stalled/case');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await result).toBe(false);
    expect(await boundedPathExists('/mnt/stalled/case')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1));
  });

  it('leaves filesystem workers available when several mounted paths stall', async () => {
    const releases: Array<() => void> = [];
    stat.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({} as never));
        })
    );

    const first = boundedPathExists('/mnt/stalled/one');
    const second = boundedPathExists('/mnt/stalled/two');
    expect(await boundedPathExists('/mnt/stalled/three')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(2);

    releases.forEach((release) => release());
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });
});
