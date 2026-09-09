/**
 * @fileoverview COD-306 browser tab-layout projection, rendering, and load coordination.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const SOURCE = readFileSync(new URL('../src/web/public/tab-layout-browser.js', import.meta.url), 'utf8');
const APP_SOURCE = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const INDEX_SOURCE = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const BUILD_SOURCE = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string };

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {}, setTimeout, clearTimeout });
  vm.runInContext(SOURCE, context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const layout = (version = 4) => ({
  version,
  updatedAt: '2026-08-16T00:00:00.000Z',
  groups: [
    {
      id: 'g1',
      name: '<Core & Ops>',
      refs: [
        { kind: 'session', id: 's2' },
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'saved-closed' },
      ],
    },
    { id: 'g2', name: 'Later', refs: [{ kind: 'session', id: 's3' }] },
  ],
  ungrouped: [
    { kind: 'webview', id: 'w2' },
    { kind: 'session', id: 's4' },
    { kind: 'session', id: 's2' },
  ],
});

describe('COD-306 browser projection', () => {
  it('builds a complete owner session compatibility order and appends live omissions', () => {
    const h = loadHelper();
    expect(
      h.project(layout(), {
        liveSessionIds: ['s1', 's2', 's3', 's4', 'legacy'],
        openWebviewIds: ['w1', 'w2'],
      }).sessionOrder
    ).toEqual(['s2', 's1', 's3', 's4', 'legacy']);
  });

  it('interleaves visible sessions and open webviews, omits unopened saved webviews, and deduplicates', () => {
    const h = loadHelper();
    const result = h.project(layout(), {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
    });
    expect(result.visibleRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
      { kind: 'session', id: 's4' },
    ]);
    expect(new Set(result.visibleRefs.map((ref: Ref) => `${ref.kind}:${ref.id}`)).size).toBe(result.visibleRefs.length);
  });

  it('honors collapse only in vertical mode and preserves the exclusive highlighted identity', () => {
    const h = loadHelper();
    const common = {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      collapsedGroupIds: ['g1'],
      activeSessionId: 's2',
      activeWebviewId: 'w1',
    };
    expect(h.project(layout(), { ...common, orientation: 'vertical' }).visibleRefs).toEqual([
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
      { kind: 'session', id: 's4' },
    ]);
    expect(h.project(layout(), { ...common, orientation: 'horizontal' }).visibleRefs.slice(0, 3)).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's1' },
    ]);
    expect(h.project(layout(), { ...common, orientation: 'vertical' }).completeRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
      { kind: 'session', id: 's4' },
    ]);
  });

  it('uses legacy order before live insertion order for authoritative omissions', () => {
    const h = loadHelper();
    const result = h.project(layout(), {
      liveSessionIds: ['new-b', 's1', 'new-a'],
      legacySessionOrder: ['s1', 'new-a', 'new-b'],
      openWebviewIds: [],
    });
    expect(result.sessionOrder).toEqual(['s1', 'new-a', 'new-b']);
    expect(result.visibleRefs.map((ref: Ref) => ref.id)).toEqual(['s1', 'new-a', 'new-b']);
  });

  it('derives vertical-only Focus refs in canonical order without changing behavioral orders', () => {
    const h = loadHelper();
    const focused = layout();
    focused.groups[0].refs[0] = { ...focused.groups[0].refs[0], focus: true };
    focused.groups[0].refs[1] = { ...focused.groups[0].refs[1], focus: true };
    focused.groups[0].refs[3] = { ...focused.groups[0].refs[3], focus: true };
    focused.ungrouped[1] = { ...focused.ungrouped[1], focus: true };
    const options = {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      collapsedGroupIds: ['g1'],
      activeSessionId: 's1',
      orientation: 'vertical',
      focusCollapsed: true,
    };

    const result = h.project(focused, options);
    expect(result.focusRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's4' },
    ]);
    expect(result.altRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's4' },
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
    ]);
    expect(result.focusCollapsed).toBe(true);
    expect(result.visibleRefs).toEqual([
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
      { kind: 'session', id: 's4' },
    ]);
    expect(result.completeRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's1' },
      { kind: 'session', id: 's3' },
      { kind: 'webview', id: 'w2' },
      { kind: 'session', id: 's4' },
    ]);

    const horizontal = h.project(focused, { ...options, orientation: 'horizontal' });
    expect(horizontal.focusRefs).toEqual([]);
    expect(horizontal.altRefs).toEqual(horizontal.visibleRefs);
  });

  it('filters an expanded projection to matching sessions while preserving grouped order and canonical metadata', () => {
    const h = loadHelper();
    const searchable = layout();
    searchable.groups[0].id = 'core';
    searchable.groups[0].refs[0] = { ...searchable.groups[0].refs[0], focus: true };
    const projection = h.project(searchable, {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      orientation: 'vertical',
    });

    const filtered = h.filterSessionProjection(projection, ['s2', 's4']);

    expect(filtered.visibleRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'session', id: 's4' },
    ]);
    expect(filtered.sections.map(({ id, count, collapsed }: any) => ({ id, count, collapsed }))).toEqual([
      { id: 'core', count: 1, collapsed: false },
      { id: null, count: 1, collapsed: false },
    ]);
    expect(filtered.focusRefs).toEqual([{ kind: 'session', id: 's2' }]);
    expect(filtered.altRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'session', id: 's4' },
    ]);
    expect(filtered.matchCount).toBe(2);
    expect(filtered.searchActive).toBe(true);
    expect(filtered.sessionOrder).toEqual(projection.sessionOrder);
    expect(filtered.completeRefs).toEqual(projection.completeRefs);
    expect(filtered.hiddenTabGroupByRef).toEqual({});
  });

  it('removes webviews and empty sections and keeps duplicate Focus placement for an empty-safe match set', () => {
    const h = loadHelper();
    const searchable = layout();
    searchable.groups[0].refs[0] = { ...searchable.groups[0].refs[0], focus: true };
    const projection = h.project(searchable, {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      orientation: 'vertical',
      focusCollapsed: true,
    });

    const filtered = h.filterSessionProjection(projection, ['s2']);
    expect(filtered.visibleRefs).toEqual([{ kind: 'session', id: 's2' }]);
    expect(filtered.focusRefs).toEqual([{ kind: 'session', id: 's2' }]);
    expect(filtered.altRefs).toEqual([{ kind: 'session', id: 's2' }]);
    expect(filtered.sections).toHaveLength(1);
    expect(filtered.sections[0].refs).toEqual([{ kind: 'session', id: 's2' }]);
    expect(filtered.sections[0].refIndices).toEqual([0]);
    expect(filtered.focusCollapsed).toBe(false);
    expect(filtered.matchCount).toBe(1);

    const empty = h.filterSessionProjection(projection, []);
    expect(empty.sections).toEqual([]);
    expect(empty.focusRefs).toEqual([]);
    expect(empty.visibleRefs).toEqual([]);
    expect(empty.altRefs).toEqual([]);
    expect(empty.matchCount).toBe(0);
  });

  it('optimistically sets and clears Focus while preserving it through ordinary edits', () => {
    const h = loadHelper();
    const initial = layout();
    const focused = h.applyOperation(initial, {
      type: 'setFocus',
      ref: { kind: 'session', id: 's2' },
      focused: true,
    });
    expect(focused.groups[0].refs[0]).toEqual({ kind: 'session', id: 's2', focus: true });

    const moved = h.applyOperation(focused, {
      type: 'moveRef',
      ref: { kind: 'session', id: 's2' },
      groupId: 'g2',
      index: 1,
    });
    expect(moved.groups[1].refs[1]).toEqual({ kind: 'session', id: 's2', focus: true });
    expect(
      h.applyOperation(moved, {
        type: 'setFocus',
        ref: { kind: 'session', id: 's2' },
        focused: false,
      }).groups[1].refs[1]
    ).toEqual({ kind: 'session', id: 's2' });
  });

  it('projects and edits an explicit Focus order without moving refs', () => {
    const h = loadHelper();
    const focused = layout();
    focused.groups[0].refs[0] = { ...focused.groups[0].refs[0], focus: true };
    focused.groups[0].refs[1] = { ...focused.groups[0].refs[1], focus: true };
    focused.ungrouped[1] = { ...focused.ungrouped[1], focus: true };
    const options = {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      orientation: 'vertical',
    };
    expect(h.project(focused, options).focusRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
      { kind: 'session', id: 's4' },
    ]);

    const moved = h.applyOperation(focused, { type: 'moveFocus', ref: { kind: 'session', id: 's4' }, index: 0 });
    expect(moved.focusOrder).toEqual([
      { kind: 'session', id: 's4' },
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
    ]);
    expect(moved.groups).toEqual(focused.groups);
    expect(moved.ungrouped).toEqual(focused.ungrouped);
    expect(h.project(moved, options).focusRefs).toEqual([
      { kind: 'session', id: 's4' },
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
    ]);
    expect(h.contentKey(moved)).not.toBe(h.contentKey(focused));

    const dropped = h.applyOperation(moved, {
      type: 'setFocus',
      ref: { kind: 'session', id: 's4' },
      focused: false,
    });
    expect(dropped.focusOrder).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
    ]);
    expect(h.project(dropped, options).focusRefs).toEqual([
      { kind: 'session', id: 's2' },
      { kind: 'webview', id: 'w1' },
    ]);
    expect(() =>
      h.applyOperation(focused, { type: 'moveFocus', ref: { kind: 'session', id: 's3' }, index: 0 })
    ).toThrow(/Focus/);
  });

  it('treats Focus membership and smart collapse as structural rendering state', () => {
    const h = loadHelper();
    const common = {
      version: 4,
      orientation: 'vertical',
      visibleRefs: [{ kind: 'session', id: 's1' }],
    };
    const plain = h.structureKey({ ...common, focusRefs: [], focusCollapsed: false });
    const focused = h.structureKey({
      ...common,
      focusRefs: [{ kind: 'session', id: 's1' }],
      focusCollapsed: false,
    });
    const collapsed = h.structureKey({
      ...common,
      focusRefs: [{ kind: 'session', id: 's1' }],
      focusCollapsed: true,
    });

    expect(focused).not.toBe(plain);
    expect(collapsed).not.toBe(focused);
  });

  it('falls back to a deterministic legacy-flat projection', () => {
    const h = loadHelper();
    const fallback = h.projectFallback({
      legacySessionOrder: ['s2', 's1'],
      liveSessionIds: ['s1', 's2', 's3'],
      openWebviewIds: ['w2', 'w1'],
    });
    expect(fallback).toEqual({
      sessionOrder: ['s2', 's1', 's3'],
      visibleRefs: [
        { kind: 'session', id: 's2' },
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's3' },
        { kind: 'webview', id: 'w2' },
        { kind: 'webview', id: 'w1' },
      ],
      completeRefs: [
        { kind: 'session', id: 's2' },
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's3' },
        { kind: 'webview', id: 'w2' },
        { kind: 'webview', id: 'w1' },
      ],
      altRefs: [
        { kind: 'session', id: 's2' },
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's3' },
        { kind: 'webview', id: 'w2' },
        { kind: 'webview', id: 'w1' },
      ],
      sections: [],
    });
  });
});

describe('COD-306 structure and activation policy', () => {
  it('renders escaped group sections in vertical mode and a flat list otherwise', () => {
    const h = loadHelper();
    const projection = h.project(layout(), {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      orientation: 'vertical',
    });
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const renderRef = (ref: Ref, index: number) =>
      `<button data-kind="${ref.kind}" data-id="${ref.id}">${index + 1}</button>`;
    const vertical = new JSDOM(`<main>${h.renderProjection(projection, 'vertical', renderRef, escape)}</main>`);
    expect(
      [...vertical.window.document.querySelectorAll('.tab-layout-group-name')].map((el) => el.textContent)
    ).toEqual(['<Core & Ops>', 'Later', 'Ungrouped']);
    expect(vertical.window.document.querySelectorAll('img')).toHaveLength(0);
    expect(vertical.window.document.querySelectorAll('button[data-kind]')).toHaveLength(projection.visibleRefs.length);

    const flat = new JSDOM(`<main>${h.renderProjection(projection, 'horizontal', renderRef, escape)}</main>`);
    expect(flat.window.document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(flat.window.document.querySelectorAll('button[data-kind]')).toHaveLength(projection.visibleRefs.length);
  });

  it('renders a sectionless fallback flat even when the device orientation is vertical', () => {
    const h = loadHelper();
    const fallback = h.projectFallback({
      legacySessionOrder: ['s2', 's1'],
      liveSessionIds: ['s1', 's2'],
      openWebviewIds: ['w1'],
    });
    const html = h.renderProjection(
      fallback,
      'vertical',
      (ref: Ref, index: number) => `<button data-id="${ref.id}">${index + 1}</button>`,
      (value: string) => value
    );
    const dom = new JSDOM(`<main>${html}</main>`);
    expect(dom.window.document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect([...dom.window.document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('renders a fixed vertical-only Focus section with shortcut-only controls', () => {
    const h = loadHelper();
    const projection = {
      visibleRefs: [{ kind: 'session', id: 'canonical' }],
      focusRefs: [
        { kind: 'session', id: 'focused' },
        { kind: 'webview', id: 'dash' },
      ],
      focusCollapsed: false,
      sections: [
        {
          id: null,
          name: '',
          refs: [{ kind: 'session', id: 'canonical' }],
          refIndices: [0],
          count: 1,
          collapsed: false,
        },
      ],
    };
    const html = h.renderProjection(
      projection,
      'vertical',
      (ref: Ref, index: number) => `<button role="tab" tabindex="0" data-canonical="${ref.id}">${index + 1}</button>`,
      (value: string) => value,
      (ref: Ref) => `<button data-tab-focus-shortcut="${ref.kind}:${ref.id}">${ref.id}</button>`
    );
    const dom = new JSDOM(`<main>${html}</main>`);
    const focus = dom.window.document.querySelector('[data-tab-focus-group]')!;

    expect(focus.previousElementSibling).toBeNull();
    expect(focus.querySelector('[data-tab-focus-toggle]')?.getAttribute('aria-expanded')).toBe('true');
    expect(focus.querySelector('.tab-layout-group-count')?.textContent).toBe('2');
    expect(focus.querySelectorAll('[data-tab-focus-shortcut]')).toHaveLength(2);
    expect(focus.querySelector('[data-tab-group-drag], .tab-layout-group-menu')).toBeNull();
    expect(focus.querySelectorAll('.tab-focus-drop-zone')).toHaveLength(3);
    expect(dom.window.document.querySelector('[data-canonical="canonical"]')).not.toBeNull();

    projection.focusCollapsed = true;
    const collapsed = new JSDOM(
      `<main>${h.renderProjection(
        projection,
        'vertical',
        () => '<button role="tab">canonical</button>',
        (value: string) => value,
        () => '<button data-tab-focus-shortcut>shortcut</button>'
      )}</main>`
    );
    expect(collapsed.window.document.querySelector('[data-tab-focus-toggle]')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(collapsed.window.document.querySelector('[data-tab-focus-shortcut]')).toBeNull();

    const horizontal = new JSDOM(
      `<main>${h.renderProjection(
        projection,
        'horizontal',
        () => '<button data-canonical>canonical</button>',
        (value: string) => value,
        () => '<button data-tab-focus-shortcut>shortcut</button>'
      )}</main>`
    );
    expect(horizontal.window.document.querySelector('[data-tab-focus-group]')).toBeNull();
  });

  it('makes ordered identities and every structural input part of the cache key', () => {
    const h = loadHelper();
    const base = {
      version: 1,
      collapsedGroupIds: ['a'],
      orientation: 'vertical',
      openWebviewIds: ['w1'],
      activeSessionId: 's1',
      activeWebviewId: null,
      visibleRefs: [
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'w1' },
      ],
      altRefs: [
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'w1' },
      ],
    };
    const key = h.structureKey(base);
    for (const changed of [
      { version: 2 },
      { collapsedGroupIds: ['b'] },
      { orientation: 'horizontal' },
      { openWebviewIds: ['w2'] },
      { activeSessionId: 's2' },
      { activeWebviewId: 'w1' },
      { visibleRefs: [...base.visibleRefs].reverse() },
      { altRefs: [...base.altRefs].reverse() },
    ])
      expect(h.structureKey({ ...base, ...changed })).not.toBe(key);
  });

  it('maps Alt numbers directly to the first nine refs', () => {
    const h = loadHelper();
    const refs = Array.from({ length: 10 }, (_, index) => ({ kind: 'session', id: `s${index + 1}` }));
    expect(h.altNumberForRef(refs, refs[0])).toBe(1);
    expect(h.altNumberForRef(refs, refs[8])).toBe(9);
    expect(h.altNumberForRef(refs, refs[9])).toBeNull();
    expect(h.refAtAltNumber(refs, 9)).toEqual({ kind: 'session', id: 's9' });
    expect(h.refAtAltNumber(refs, 10)).toBeNull();
  });

  it('traverses the complete session projection independently of visible DOM', () => {
    const h = loadHelper();
    const order = ['s1', 'hidden', 's3'];
    expect(h.adjacentSession(order, 's1', 1)).toBe('hidden');
    expect(h.adjacentSession(order, 's1', -1)).toBe('s3');
  });
});

describe('COD-305 local collapse policy', () => {
  function storage(initial: string | null = null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set('codeman:tab-groups-collapsed', initial);
    return {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, next: string) => {
        values.set(key, next);
      }),
    };
  }

  it('round-trips collapsed group IDs across a browser restart', () => {
    const h = loadHelper();
    const local = storage();
    expect(h.saveCollapsedGroupIds(local, ['g2', 'g1'])).toEqual({ ids: ['g2', 'g1'], ok: true });
    expect(h.loadCollapsedGroupIds(local, ['g1', 'g2'])).toEqual({ ids: ['g2', 'g1'], ok: true });
    expect(local.setItem).toHaveBeenCalledWith('codeman:tab-groups-collapsed', '["g2","g1"]');
  });

  it('keeps Focus collapse storage independent from a real group named @focus', () => {
    const h = loadHelper();
    const local = storage();
    expect(h.saveCollapsedGroupIds(local, ['@focus', 'stale']).ok).toBe(true);
    expect(h.saveFocusGroupCollapsed(local, true)).toEqual({ collapsed: true, ok: true });
    expect(h.loadCollapsedGroupIds(local, ['@focus'])).toEqual({ ids: ['@focus'], ok: true });
    expect(h.loadFocusGroupCollapsed(local)).toEqual({ collapsed: true, ok: true });
    expect(local.setItem).toHaveBeenCalledWith('codeman:focus-group-collapsed', 'true');
  });

  it('garbage-collects stale group IDs during layout adoption', () => {
    const h = loadHelper();
    const local = storage('["gone","g1"]');
    expect(h.loadCollapsedGroupIds(local, ['g1', 'g2'])).toEqual({ ids: ['g1'], ok: true });
    expect(local.setItem).toHaveBeenLastCalledWith('codeman:tab-groups-collapsed', '["g1"]');
  });

  it('falls back to all-expanded after either a read or write failure', () => {
    const h = loadHelper();
    const readFailure = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: vi.fn(),
    };
    const writeFailure = {
      getItem: () => '["g1"]',
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(h.loadCollapsedGroupIds(readFailure, ['g1'])).toEqual({ ids: [], ok: false });
    expect(h.saveCollapsedGroupIds(writeFailure, ['g1'])).toEqual({ ids: [], ok: false });
    expect(h.loadFocusGroupCollapsed(readFailure)).toEqual({ collapsed: false, ok: false });
    expect(h.saveFocusGroupCollapsed(writeFailure, true)).toEqual({ collapsed: false, ok: false });
  });

  it('renders stable clickable group headers with collapse state', () => {
    const h = loadHelper();
    const projection = h.project(layout(), {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      collapsedGroupIds: ['g1'],
      orientation: 'vertical',
    });
    const html = h.renderProjection(
      projection,
      'vertical',
      (ref: Ref) => `<span data-id="${ref.id}"></span>`,
      (value: string) => value
    );
    const dom = new JSDOM(`<main>${html}</main>`);
    const header = dom.window.document.querySelector('[data-tab-group-header="g1"]');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.getAttribute('data-tab-group-header')).toBe('g1');
    expect(header?.tagName).toBe('BUTTON');
  });
});

describe('COD-306 load coordination', () => {
  it('defers first paint until success and ignores stale concurrent responses', async () => {
    const h = loadHelper();
    const pending: Array<(value: unknown) => void> = [];
    const applied: number[] = [];
    const fallback = vi.fn();
    const coordinator = h.createLoadCoordinator({
      fetchLayout: () => new Promise((resolve) => pending.push(resolve)),
      applyLayout: (value: any) => applied.push(value.version),
      applyFallback: fallback,
      scheduleRetry: vi.fn(),
    });
    const first = coordinator.load();
    expect(applied).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    const second = coordinator.load();
    pending[1](layout(2));
    await second;
    pending[0](layout(1));
    await first;
    expect(applied).toEqual([2]);
  });

  it('paints read-only fallback on failure, schedules retry, and successful retry replaces it', async () => {
    const h = loadHelper();
    const applyLayout = vi.fn();
    const applyFallback = vi.fn();
    let retry: (() => void) | undefined;
    let attempt = 0;
    const coordinator = h.createLoadCoordinator({
      fetchLayout: async () => {
        attempt++;
        if (attempt === 1) throw new Error('offline');
        return layout(7);
      },
      applyLayout,
      applyFallback,
      scheduleRetry: (fn: () => void) => {
        retry = fn;
        return 42;
      },
      cancelRetry: vi.fn(),
    });
    await coordinator.load();
    expect(applyFallback).toHaveBeenCalledWith({ readOnly: true });
    expect(retry).toBeTypeOf('function');
    await retry!();
    expect(applyLayout).toHaveBeenCalledWith(layout(7));
    coordinator.dispose();
  });
});

describe('COD-306 browser wiring', () => {
  it('loads the helper before app.js and wires owner layout GET plus SSE invalidation', () => {
    expect(INDEX_SOURCE.indexOf('<script defer src="tab-layout-browser.js"')).toBeLessThan(
      INDEX_SOURCE.indexOf('<script defer src="app.js"')
    );
    expect(APP_SOURCE).toContain("this._apiJson('/api/tab-layout'");
    expect(APP_SOURCE).toContain("[SSE_EVENTS.TAB_LAYOUT_CHANGED, '_onTabLayoutChanged']");
    expect(BUILD_SOURCE).toContain("'tab-layout-browser.js'");
  });

  it('keeps initial tab painting behind the layout load gate and has no legacy session-order writer', () => {
    expect(APP_SOURCE).toContain('if (this._tabLayoutFirstPaintPending) return;');
    expect(APP_SOURCE).not.toContain("fetch('/api/session-order'");
  });
});
