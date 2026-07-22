/**
 * @fileoverview Executes the production-built checkpoint CLI against a controlled API.
 *
 * This closes the stale ignored-dist blind spot: the test builds first, then
 * launches `node dist/index.js checkpoint` rather than importing source helpers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_KILL_GRACE_MS = 500;

describe('built checkpoint CLI', () => {
  let server: Server | undefined;
  let apiUrl = '';
  let response: { status: number; body: string; contentType?: string };
  const children = new Set<ReturnType<typeof spawn>>();

  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { timeout: 120_000 });
    response = { status: 200, body: 'null' };
    const candidate = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(response.status, { 'Content-Type': response.contentType ?? 'application/json' });
        res.end(response.body);
      });
    });
    server = candidate;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      candidate.once('error', onError);
      candidate.listen(0, '127.0.0.1', () => {
        candidate.off('error', onError);
        resolve();
      });
    });
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    apiUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    const runningChildren = [...children];
    await Promise.all(
      runningChildren.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            let finished = false;
            const finish = (): void => {
              if (finished) return;
              finished = true;
              clearTimeout(forceKill);
              clearTimeout(giveUp);
              resolve();
            };
            const forceKill = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
            const giveUp = setTimeout(finish, CHILD_KILL_GRACE_MS * 2);
            child.once('close', finish);
            child.kill('SIGTERM');
          })
      )
    );

    if (!server) return;
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  function runCheckpoint(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['dist/index.js', 'checkpoint', '--session', 'built-cli-test', '--url', apiUrl],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEMAN_HOOK_SECRET_FILE: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      children.add(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
        settle(() => reject(new Error(`checkpoint CLI timed out after ${CHILD_TIMEOUT_MS}ms`)));
      }, CHILD_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => settle(() => reject(error)));
      child.on('close', (code) => {
        if (forceKill) clearTimeout(forceKill);
        children.delete(child);
        settle(() => resolve({ code, stdout, stderr }));
      });
    });
  }

  it.each([
    ['null', { status: 200, body: 'null' }, /empty response/i],
    ['non-JSON', { status: 200, body: '<html>broken</html>', contentType: 'text/html' }, /non-JSON response/i],
    ['HTTP failure', { status: 503, body: JSON.stringify({ success: false, error: 'unavailable' }) }, /HTTP 503/i],
    ['malformed success', { status: 200, body: JSON.stringify({ success: true, data: null }) }, /malformed success/i],
  ])('returns a clean non-zero result for %s', async (_label, nextResponse, expected) => {
    response = nextResponse;
    const result = await runCheckpoint();
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect(result.stderr).not.toMatch(/Unhandled rejection|TypeError/);
  });

  it('reports a well-formed refusal reason', async () => {
    response = {
      status: 200,
      body: JSON.stringify({ success: true, data: { checkpoint: { triggered: false, reason: 'busy' } } }),
    };
    const result = await runCheckpoint();
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/already running/i);
    expect(result.stderr).not.toMatch(/Unhandled rejection|TypeError/);
  });

  it('reports request acceptance without claiming completion', async () => {
    response = {
      status: 200,
      body: JSON.stringify({ success: true, data: { checkpoint: { triggered: true } } }),
    };
    const result = await runCheckpoint();
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/checkpoint compact requested/i);
    expect(result.stdout).not.toMatch(/\bdone\b/i);
    expect(result.stderr).toBe('');
  });
});
