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
  let responseForRequest:
    | ((method: string | undefined) => { status: number; body: string; contentType?: string })
    | undefined;
  let trickleNextGet = false;
  const children = new Set<ReturnType<typeof spawn>>();

  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { timeout: 120_000 });
    response = { status: 200, body: 'null' };
    const candidate = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (trickleNextGet && req.method === 'GET') {
          trickleNextGet = false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const interval = setInterval(() => res.write(' '), 250);
          res.once('close', () => clearInterval(interval));
          return;
        }
        const selected = responseForRequest?.(req.method) ?? response;
        res.writeHead(selected.status, { 'Content-Type': selected.contentType ?? 'application/json' });
        res.end(selected.body);
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

  function runCheckpoint(
    extraArgs: string[] = [],
    envOverrides: Record<string, string> = {}
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['dist/index.js', 'checkpoint', '--session', 'built-cli-test', '--url', apiUrl, ...extraArgs],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEMAN_HOOK_SECRET_FILE: '', ...envOverrides },
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
      body: JSON.stringify({ success: true, data: { checkpoint: { triggered: true, runId: 'built-run-262' } } }),
    };
    const result = await runCheckpoint();
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/checkpoint compact requested/i);
    expect(result.stdout).toMatch(/built-run-262/);
    expect(result.stdout).not.toMatch(/\bdone\b/i);
    expect(result.stderr).toBe('');
  });

  it('refuses self-targeted --wait before making a request', async () => {
    const result = await runCheckpoint(['--wait'], { CODEMAN_SESSION_ID: 'built-cli-test' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/must yield first/i);
  });

  it('waits externally for the matching run id', async () => {
    responseForRequest = (method) =>
      method === 'GET'
        ? {
            status: 200,
            body: JSON.stringify({
              success: true,
              data: {
                checkpoint: { runId: 'newer-run', status: 'running' },
                checkpointRuns: {
                  'wait-run-262': { runId: 'wait-run-262', status: 'completed' },
                  'newer-run': { runId: 'newer-run', status: 'running' },
                },
              },
            }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              success: true,
              data: { checkpoint: { triggered: true, runId: 'wait-run-262' } },
            }),
          };
    const result = await runCheckpoint(['--wait']);
    responseForRequest = undefined;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/wait-run-262 completed/i);
  });

  it('enforces an absolute timeout on a trickling status GET and retries within the lifecycle bound', async () => {
    trickleNextGet = true;
    responseForRequest = (method) =>
      method === 'GET'
        ? {
            status: 200,
            body: JSON.stringify({
              success: true,
              data: { checkpointRuns: { 'stall-run-262': { runId: 'stall-run-262', status: 'completed' } } },
            }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              success: true,
              data: { checkpoint: { triggered: true, runId: 'stall-run-262' } },
            }),
          };
    const result = await runCheckpoint(['--wait']);
    responseForRequest = undefined;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/stall-run-262 completed/i);
  });

  it('retries transient status errors and completes the exact run', async () => {
    let getCount = 0;
    responseForRequest = (method) => {
      if (method !== 'GET') {
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            data: { checkpoint: { triggered: true, runId: 'retry-run-262' } },
          }),
        };
      }
      getCount += 1;
      if (getCount < 3) return { status: 503, body: JSON.stringify({ error: 'transient' }) };
      return {
        status: 200,
        body: JSON.stringify({
          success: true,
          data: { checkpointRuns: { 'retry-run-262': { runId: 'retry-run-262', status: 'completed' } } },
        }),
      };
    };
    const result = await runCheckpoint(['--wait']);
    responseForRequest = undefined;
    expect(result.code).toBe(0);
    expect(getCount).toBe(3);
  });
});
