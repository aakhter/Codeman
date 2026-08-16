/**
 * @fileoverview Framework-independent browser projection for owner tab layouts.
 *
 * Browser assets cannot import the TypeScript server model, so this small mirror
 * owns only read-time projection and request sequencing. The server remains the
 * authority for validation, normalization, persistence, and editing.
 */

(function initCodemanTabLayout(global) {
  'use strict';

  const refKey = (ref) => `${ref.kind}:${ref.id}`;
  const validRef = (ref) =>
    ref && (ref.kind === 'session' || ref.kind === 'webview') && typeof ref.id === 'string' && ref.id.length > 0;
  const asIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []);
  const stableIds = (value) => [...new Set(asIds(value))];

  function normalizedLayout(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid tab layout');
    const groups = Array.isArray(value.groups) ? value.groups : [];
    const ungrouped = Array.isArray(value.ungrouped) ? value.ungrouped : [];
    return {
      version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      groups: groups.map((group) => ({
        id: typeof group?.id === 'string' ? group.id : '',
        name: typeof group?.name === 'string' ? group.name : '',
        refs: Array.isArray(group?.refs)
          ? group.refs.filter(validRef).map((ref) => ({ kind: ref.kind, id: ref.id }))
          : [],
      })),
      ungrouped: ungrouped.filter(validRef).map((ref) => ({ kind: ref.kind, id: ref.id })),
    };
  }

  function project(layoutInput, options = {}) {
    const layout = normalizedLayout(layoutInput);
    const liveSessionIds = new Set(asIds(options.liveSessionIds));
    const openWebviewIds = new Set(asIds(options.openWebviewIds));
    const legacySessionOrder = stableIds(options.legacySessionOrder);
    const collapsed = new Set(asIds(options.collapsedGroupIds));
    const orientation = options.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const highlighted = options.activeWebviewId
      ? `webview:${options.activeWebviewId}`
      : options.activeSessionId
        ? `session:${options.activeSessionId}`
        : '';
    const seen = new Set();
    const storedKeys = new Set([
      ...layout.groups.flatMap((group) => group.refs.map(refKey)),
      ...layout.ungrouped.map(refKey),
    ]);
    const processedStoredKeys = new Set();
    const ownerSessions = [];
    const visibleRefs = [];
    const sections = [];

    const renderable = (ref) => (ref.kind === 'session' ? liveSessionIds.has(ref.id) : openWebviewIds.has(ref.id));
    const addVisible = (ref, sectionRefs, isCollapsed, stored = true) => {
      const key = refKey(ref);
      if (stored) {
        if (processedStoredKeys.has(key)) return;
        processedStoredKeys.add(key);
      } else if (storedKeys.has(key)) {
        return;
      }
      if (!renderable(ref) || seen.has(key)) return;
      if (orientation === 'vertical' && isCollapsed && key !== highlighted) return;
      seen.add(key);
      const copy = { kind: ref.kind, id: ref.id };
      visibleRefs.push(copy);
      sectionRefs.push(copy);
    };

    // Compatibility projection includes every owner session in the authoritative
    // layout, even when collapse removes it from the visible rail.
    const ownerSeen = new Set();
    for (const group of layout.groups) {
      for (const ref of group.refs) {
        if (ref.kind === 'session' && liveSessionIds.has(ref.id) && !ownerSeen.has(ref.id)) {
          ownerSeen.add(ref.id);
          ownerSessions.push(ref.id);
        }
      }
    }
    for (const ref of layout.ungrouped) {
      if (ref.kind === 'session' && liveSessionIds.has(ref.id) && !ownerSeen.has(ref.id)) {
        ownerSeen.add(ref.id);
        ownerSessions.push(ref.id);
      }
    }
    for (const id of legacySessionOrder) {
      if (liveSessionIds.has(id) && !ownerSeen.has(id)) {
        ownerSeen.add(id);
        ownerSessions.push(id);
      }
    }
    for (const id of liveSessionIds) if (!ownerSeen.has(id)) ownerSessions.push(id);

    for (const group of layout.groups) {
      const refs = [];
      for (const ref of group.refs) addVisible(ref, refs, collapsed.has(group.id));
      if (orientation === 'vertical') sections.push({ id: group.id, name: group.name, refs });
    }
    const ungroupedRefs = [];
    for (const ref of layout.ungrouped) addVisible(ref, ungroupedRefs, false);

    // A newly opened local webview or live session may predate server
    // reconciliation. Append omissions deterministically without moving saved refs.
    for (const id of ownerSessions) addVisible({ kind: 'session', id }, ungroupedRefs, false, false);
    for (const id of openWebviewIds) addVisible({ kind: 'webview', id }, ungroupedRefs, false, false);
    if (orientation === 'vertical') sections.push({ id: null, name: '', refs: ungroupedRefs });

    return { sessionOrder: ownerSessions, visibleRefs, sections };
  }

  function projectFallback(options = {}) {
    const legacy = stableIds(options.legacySessionOrder);
    const live = stableIds(options.liveSessionIds);
    const sessionOrder = [...legacy.filter((id) => live.includes(id)), ...live.filter((id) => !legacy.includes(id))];
    return {
      sessionOrder,
      visibleRefs: [
        ...sessionOrder.map((id) => ({ kind: 'session', id })),
        ...stableIds(options.openWebviewIds).map((id) => ({ kind: 'webview', id })),
      ],
      sections: [],
    };
  }

  function collapsedHash(value) {
    return stableIds(value).sort().join('\u001f');
  }

  function structureKey(input = {}) {
    return JSON.stringify({
      version: Number.isSafeInteger(input.version) ? input.version : null,
      collapsed: collapsedHash(input.collapsedGroupIds),
      orientation: input.orientation || 'horizontal',
      openWebviews: stableIds(input.openWebviewIds),
      activeSessionId: input.activeSessionId || null,
      activeWebviewId: input.activeWebviewId || null,
      refs: (Array.isArray(input.visibleRefs) ? input.visibleRefs : []).filter(validRef).map(refKey),
    });
  }

  function refAtAltNumber(refs, number) {
    if (!Number.isInteger(number) || number < 1 || number > 9) return null;
    const ref = Array.isArray(refs) ? refs[number - 1] : null;
    return validRef(ref) ? { kind: ref.kind, id: ref.id } : null;
  }

  function adjacentSession(orderInput, activeId, delta) {
    const order = stableIds(orderInput);
    if (order.length <= 1) return null;
    const current = order.indexOf(activeId);
    const start = current < 0 ? (delta < 0 ? 0 : -1) : current;
    return order[(start + (delta < 0 ? -1 : 1) + order.length) % order.length] || null;
  }

  function renderProjection(projection, orientation, renderRef, escapeHtml) {
    const refs = Array.isArray(projection?.visibleRefs) ? projection.visibleRefs : [];
    const sections = Array.isArray(projection?.sections) ? projection.sections : [];
    if (orientation !== 'vertical' || sections.length === 0) {
      return refs.map((ref, index) => renderRef(ref, index)).join('');
    }
    let index = 0;
    return sections
      .map((section) => {
        const name = section.id === null ? 'Ungrouped' : section.name;
        const content = (Array.isArray(section.refs) ? section.refs : [])
          .map((ref) => renderRef(ref, index++))
          .join('');
        return `<section class="tab-layout-group" data-tab-group-id="${escapeHtml(section.id || '')}" role="group" aria-label="${escapeHtml(name)}"><div class="tab-layout-group-name">${escapeHtml(name)}</div><div class="tab-layout-group-refs">${content}</div></section>`;
      })
      .join('');
  }

  function createLoadCoordinator(options) {
    let generation = 0;
    let disposed = false;
    let retryHandle = null;

    const clearRetry = () => {
      if (retryHandle !== null && options.cancelRetry) options.cancelRetry(retryHandle);
      retryHandle = null;
    };
    const load = async () => {
      if (disposed) return false;
      const requestGeneration = ++generation;
      clearRetry();
      try {
        const layout = await options.fetchLayout();
        if (disposed || requestGeneration !== generation) return false;
        options.applyLayout(layout);
        return true;
      } catch {
        if (disposed || requestGeneration !== generation) return false;
        options.applyFallback({ readOnly: true });
        retryHandle = options.scheduleRetry(() => load());
        return false;
      }
    };
    return {
      load,
      dispose() {
        disposed = true;
        generation++;
        clearRetry();
      },
    };
  }

  global.CodemanTabLayout = {
    project,
    projectFallback,
    collapsedHash,
    structureKey,
    refAtAltNumber,
    adjacentSession,
    renderProjection,
    createLoadCoordinator,
  };
})(typeof window !== 'undefined' ? window : globalThis);
