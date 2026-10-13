/**
 * @fileoverview The browser's Focus edits, sent the way the browser sends them,
 * accepted by the REAL server service (COD-515).
 *
 * A Focus change goes out as semantic operations (`PUT /api/tab-layout
 * { operations }`), and the server validates them strictly: every moveRef needs
 * an explicit index. The browser's "move to the end of that group" carries none,
 * so dragging a Focus row out onto a group header produced a batch the server
 * rejected. These tests run the browser module's own drop -> wireOperations
 * output through TabLayoutService.putOperations rather than a fetch stub.
 *
 * Port: none (vm-loaded browser module + in-memory service).
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
import type { TabLayout } from '../src/tab-layout.js';

const SOURCE = readFileSync(new URL('../src/web/public/tab-layout-browser.js', import.meta.url), 'utf8');

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(SOURCE, context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const TL = loadHelper();

const s = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'session' as const, id, ...extra });
const keys = (refs: Array<{ kind: string; id: string }>) => refs.map((ref) => `${ref.kind}:${ref.id}`);

const layout = (): TabLayout => ({
  version: 7,
  updatedAt: '2026-10-13T00:00:00.000Z',
  groups: [
    { id: 'ga', name: 'A', refs: [s('s1', { focus: true }), s('s2')] },
    { id: 'gb', name: 'B', refs: [s('s3'), s('s4')] },
  ],
  ungrouped: [s('s5')],
  focusOrder: [{ kind: 'session', id: 's1' }],
});

function harness(initial: TabLayout) {
  const layouts: Record<string, TabLayout> = { '@single': initial };
  let order: string[] = [];
  const store = {
    getTabLayout: vi.fn((owner: string) => layouts[owner] ?? null),
    getTabLayouts: vi.fn(() => structuredClone(layouts)),
    setTabLayout: vi.fn((owner: string, value: TabLayout) => {
      layouts[owner] = value;
    }),
    getSessions: vi.fn(() => ({})),
    getSessionOrder: vi.fn(() => [...order]),
    commitTabLayoutProjection: vi.fn(
      (updates: Readonly<Record<string, TabLayout>>, project: (latest: readonly string[]) => readonly string[]) => {
        order = [...project([...order])];
        for (const [owner, value] of Object.entries(updates)) layouts[owner] = value;
        return { layouts: structuredClone(updates), sessionOrder: [...order] };
      }
    ),
    getCaseDefaultGroup: vi.fn(() => undefined),
    setCaseDefaultGroup: vi.fn(),
  };
  const live = new Map(['s1', 's2', 's3', 's4', 's5'].map((id, i) => [id, { id, createdAt: i + 1 }]));
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews: vi.fn(async () => []),
    broadcast: vi.fn(),
    broadcastSessionOrder: vi.fn(),
    now: () => '2026-10-13T12:00:00.000Z',
  });
  return service;
}

const asList = (operation: unknown) => (Array.isArray(operation) ? operation : [operation]);

describe('Focus drops reach the server in a form it accepts', () => {
  it('a Focus row dropped on another group header leaves Focus and lands at that group end', async () => {
    const drop = TL.dropOperation(layout(), { type: 'ref', ref: s('s1') }, { type: 'group', groupId: 'gb' }, {});
    // The browser's own move carries no index (it means "the end").
    expect(asList(drop)[1]).not.toHaveProperty('index');
    const wire = TL.wireOperations(layout(), asList(drop));
    expect(wire[1]).toEqual({ type: 'moveRef', ref: s('s1'), groupId: 'gb', index: 2 });

    const result = await harness(layout()).putOperations('@single', wire, 7);
    expect(result.status).toBe('updated');
    expect(keys(result.layout.groups[1].refs)).toEqual(['session:s3', 'session:s4', 'session:s1']);
    expect(result.layout.groups[1].refs[2]).not.toHaveProperty('focus');
    // The server agrees with what the browser painted optimistically.
    const optimistic = asList(drop).reduce((current: unknown, op: unknown) => TL.applyOperation(current, op), layout());
    expect(keys(optimistic.groups[1].refs)).toEqual(keys(result.layout.groups[1].refs));
  });

  it('a Focus row dropped on the Ungrouped section lands at its end', async () => {
    const drop = TL.dropOperation(layout(), { type: 'ref', ref: s('s1') }, { type: 'ungrouped' }, {});
    const wire = TL.wireOperations(layout(), asList(drop));
    expect(wire[1]).toMatchObject({ type: 'moveRef', groupId: null, index: 1 });
    const result = await harness(layout()).putOperations('@single', wire, 7);
    expect(keys(result.layout.ungrouped)).toEqual(['session:s5', 'session:s1']);
  });

  it('the unfilled batch is what the server refuses (the bug this pins)', async () => {
    const drop = TL.dropOperation(layout(), { type: 'ref', ref: s('s1') }, { type: 'group', groupId: 'gb' }, {});
    await expect(harness(layout()).putOperations('@single', asList(drop), 7)).rejects.toThrow(/moveRef/);
  });

  it('joining Focus at a slot and reordering Focus are accepted as sent', async () => {
    const join = TL.dropOperation(
      layout(),
      { type: 'ref', ref: s('s3') },
      { type: 'ref', ref: s('s1'), groupId: ':focus', placement: 'before' },
      {}
    );
    const result = await harness(layout()).putOperations('@single', TL.wireOperations(layout(), asList(join)), 7);
    expect(result.layout.focusOrder).toEqual([
      { kind: 'session', id: 's3' },
      { kind: 'session', id: 's1' },
    ]);
  });

  it('keeps an explicit index, strips the browser-only parents hint, and drops an edit that no longer applies', () => {
    const wire = TL.wireOperations(layout(), [
      { type: 'setFocus', ref: s('s2'), focused: true },
      { type: 'moveRef', ref: s('s2'), groupId: 'gb', index: 0, parents: { s2: 's1' } },
      { type: 'moveRef', ref: s('gone'), groupId: null },
    ]);
    expect(wire).toEqual([
      { type: 'setFocus', ref: s('s2'), focused: true },
      { type: 'moveRef', ref: s('s2'), groupId: 'gb', index: 0 },
    ]);
  });
});

describe('the editor sends wire operations', () => {
  it('a coordinator flush of a Focus drag-out carries an indexed moveRef', async () => {
    const puts: any[] = [];
    const editor = TL.createEditCoordinator({
      initialLayout: layout(),
      put: async (request: any) => {
        puts.push(request);
        return { ok: true, status: 200, layout: { ...request.layout, version: request.baseVersion + 1 } };
      },
      applyLayout: () => {},
      schedule: (fn: () => void) => setTimeout(fn, 0),
    });
    const drop = TL.dropOperation(layout(), { type: 'ref', ref: s('s1') }, { type: 'group', groupId: 'gb' }, {});
    for (const op of asList(drop)) editor.enqueue(op);
    expect(editor.pendingWireOperations()[1]).toMatchObject({ type: 'moveRef', index: 2 });
    await editor.flush();
    expect(puts[0].operations[1]).toEqual({ type: 'moveRef', ref: s('s1'), groupId: 'gb', index: 2 });
  });
});
