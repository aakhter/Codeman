/**
 * @fileoverview Tests for the `status` and `ls` CLI commands' live-query helpers
 * (COD-89).
 *
 * The bug: `status`/`ls` built fresh in-process singletons in the short-lived CLI
 * process, which has no view of the long-running web server's sessions, so they
 * always reported empty/zero. The fix queries the running server over HTTP
 * (`/api/status`, `/api/sessions`) and only falls back to persisted state when
 * the server is unreachable. These tests cover the PURE helpers that summarize
 * the `/api/status` payload, render the session rows, and pick the live-vs-stored
 * source for the offline fallback — including the `{success,data}` envelope
 * unwrap and defensive handling when `data` is shaped as a list vs an object.
 */

import { describe, it, expect } from 'vitest';
import { summarizeStatus, formatSessionRows, selectSessionSource, unwrapEnvelope } from '../src/cli.js';

// A representative GET /api/status payload (already-unwrapped `data`): the light
// state carries `sessions[]` (each with status, ralphLoop, taskStats) plus
// globalStats — there is no top-level task-queue/ralph block, so counts are
// derived from the sessions array.
const liveStatusPayload = {
  version: '0.9.10',
  sessions: [
    {
      id: 'aaaaaaaa-1111',
      status: 'idle',
      workingDir: '/home/u/proj-a',
      taskStats: { total: 2, running: 0, completed: 2, failed: 0 },
      ralphLoop: { enabled: false, active: false },
    },
    {
      id: 'bbbbbbbb-2222',
      status: 'busy',
      workingDir: '/home/u/proj-b',
      taskStats: { total: 3, running: 1, completed: 1, failed: 1 },
      ralphLoop: { enabled: true, active: true },
    },
    {
      id: 'cccccccc-3333',
      status: 'busy',
      workingDir: '/home/u/proj-c',
      taskStats: { total: 0, running: 0, completed: 0, failed: 0 },
      ralphLoop: { enabled: false, active: false },
    },
  ],
  globalStats: {
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCost: 1.5,
    totalSessionsCreated: 9,
    activeSessionsCount: 3,
  },
};

describe('summarizeStatus', () => {
  it('derives non-zero session counts from a live /api/status payload', () => {
    const s = summarizeStatus(liveStatusPayload);
    expect(s.active).toBe(3); // all 3 sessions are live/non-stopped
    expect(s.idle).toBe(1);
    expect(s.busy).toBe(2);
  });

  it('aggregates per-session task stats into totals', () => {
    const s = summarizeStatus(liveStatusPayload);
    expect(s.tasks.total).toBe(5);
    expect(s.tasks.running).toBe(1);
    expect(s.tasks.completed).toBe(3);
    expect(s.tasks.failed).toBe(1);
  });

  it('reports the ralph loop as active when any session has an active loop', () => {
    const s = summarizeStatus(liveStatusPayload);
    expect(s.ralphActive).toBe(true);
  });

  it('is defensive when sessions is missing or status is empty', () => {
    const s = summarizeStatus({});
    expect(s.active).toBe(0);
    expect(s.idle).toBe(0);
    expect(s.busy).toBe(0);
    expect(s.tasks.total).toBe(0);
    expect(s.ralphActive).toBe(false);
  });

  it('accepts sessions nested under .sessions or as a bare array', () => {
    const fromArray = summarizeStatus(liveStatusPayload.sessions);
    expect(fromArray.active).toBe(3);
    expect(fromArray.busy).toBe(2);
  });
});

describe('formatSessionRows', () => {
  it('renders one row per session (not the (none) placeholder)', () => {
    const out = formatSessionRows(liveStatusPayload.sessions);
    expect(out).not.toMatch(/\(none\)/);
    expect(out).toContain('aaaaaaaa'); // short id
    expect(out).toContain('bbbbbbbb');
    expect(out).toContain('cccccccc');
    expect(out).toContain('/home/u/proj-a');
    expect(out).toContain('idle');
    expect(out).toContain('busy');
  });

  it('returns a (none) placeholder for an empty list', () => {
    expect(formatSessionRows([])).toMatch(/\(none\)/);
  });
});

describe('selectSessionSource (offline fallback)', () => {
  it('uses live sessions when present and is not offline', () => {
    const sel = selectSessionSource(liveStatusPayload.sessions, {});
    expect(sel.offline).toBe(false);
    expect(sel.sessions).toHaveLength(3);
  });

  it('falls back to stored sessions (rendered, not (none)) when live is unreachable/empty', () => {
    const stored = {
      'dddddddd-4444': { id: 'dddddddd-4444', status: 'idle', workingDir: '/home/u/stored' },
      'eeeeeeee-5555': { id: 'eeeeeeee-5555', status: 'stopped', workingDir: '/home/u/old' },
    };
    const sel = selectSessionSource(null, stored);
    expect(sel.offline).toBe(true);
    expect(sel.sessions.length).toBe(2);
    const out = formatSessionRows(sel.sessions);
    expect(out).not.toMatch(/\(none\)/);
    expect(out).toContain('/home/u/stored');
  });

  it('is empty (no offline data) when both live and stored are empty', () => {
    const sel = selectSessionSource(null, {});
    expect(sel.sessions).toHaveLength(0);
  });
});

describe('unwrapEnvelope', () => {
  it('unwraps the {success,data} envelope', () => {
    expect(unwrapEnvelope({ success: true, data: { x: 1 } })).toEqual({ x: 1 });
  });

  it('returns the body as-is when there is no envelope', () => {
    expect(unwrapEnvelope({ x: 1 })).toEqual({ x: 1 });
  });

  it('handles data being a list', () => {
    expect(unwrapEnvelope({ success: true, data: [1, 2, 3] })).toEqual([1, 2, 3]);
  });
});
