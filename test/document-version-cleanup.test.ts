/**
 * @fileoverview Closing a session frees its document version history (COD-457).
 *
 * `documentVersionStore` is a module singleton holding full document bodies
 * (and raw .docx bytes) per (session, file). Its `clearSession()` had no
 * caller, so every closed session's history lived until the server restarted.
 * This drives the REAL path: the history is recorded through the versions
 * route and released through `DELETE /api/sessions/:id` (-> cleanupSession).
 *
 * Port: 3311
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { documentVersionStore } from '../src/document-version-store.js';


describe('closing a session clears its document version history', () => {
  let server: WebServer;
  let workingDir: string;
  // Ephemeral port (test-ports-guard): set once the server has bound.
  let base = '';

  beforeAll(async () => {
    workingDir = mkdtempSync(join(tmpdir(), 'codeman-docver-'));
    writeFileSync(join(workingDir, 'draft.md'), '# draft v1\n');
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(workingDir, { recursive: true, force: true });
  }, 60000);

  const create = async (): Promise<string> => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir }),
    });
    const body = await res.json();
    return body.data.session.id as string;
  };

  const recordVersion = async (id: string) => {
    const res = await fetch(`${base}/api/sessions/${id}/documents/versions?path=draft.md`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.versions).toHaveLength(1);
    expect(documentVersionStore.hasSession(id)).toBe(true);
  };

  it('DELETE (kill) drops the history', async () => {
    const id = await create();
    await recordVersion(id);
    expect((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(documentVersionStore.hasSession(id)).toBe(false);
  });

  it('DELETE ?killMux=false (detach) drops the history too, since the session leaves the server', async () => {
    const id = await create();
    await recordVersion(id);
    expect((await fetch(`${base}/api/sessions/${id}?killMux=false`, { method: 'DELETE' })).status).toBe(200);
    expect(documentVersionStore.hasSession(id)).toBe(false);
  });
});
