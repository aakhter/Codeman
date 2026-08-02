/**
 * @fileoverview COD-257 regression: checkpoint creation must not use a stale settings cache after save.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';

vi.mock('../src/mux-factory.js', () => ({
  createMultiplexer: vi.fn(() => ({ on: vi.fn() })),
}));

import { WebServer } from '../src/web/server.js';

describe('COD-257 checkpoint default cache', () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop().catch(() => {});
    server = undefined;
  });

  it('observes an immediately saved checkpoint default rather than a cached prior value', async () => {
    const readFile = vi
      .spyOn(fs, 'readFile')
      .mockResolvedValueOnce(JSON.stringify({ checkpointDefaultEnabled: false }) as never)
      .mockResolvedValueOnce(JSON.stringify({ checkpointDefaultEnabled: true }) as never);
    server = new WebServer(0, false, true);
    const getCheckpointDefaultEnabled = (
      server as unknown as { getCheckpointDefaultEnabled(): Promise<boolean> }
    ).getCheckpointDefaultEnabled.bind(server);

    expect(await getCheckpointDefaultEnabled()).toBe(false);
    expect(await getCheckpointDefaultEnabled()).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it.each(['null', '[]', '"not a settings object"'])('treats persisted %s as the enabled fallback', async (raw) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(raw as never);
    server = new WebServer(0, false, true);
    const getCheckpointDefaultEnabled = (
      server as unknown as { getCheckpointDefaultEnabled(): Promise<boolean> }
    ).getCheckpointDefaultEnabled.bind(server);

    await expect(getCheckpointDefaultEnabled()).resolves.toBe(true);
  });
});
