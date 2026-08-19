/**
 * @fileoverview Framework-independent browser projection for owner tab layouts.
 *
 * Browser assets cannot import the TypeScript server model, so this small mirror
 * owns read-time projection, a deliberately small semantic-operation mirror,
 * and request sequencing. The server remains the validation and persistence
 * authority; operations are named so conflicts can be rebased without merging
 * arrays.
 */

(function initCodemanTabLayout(global) {
  'use strict';

  const refKey = (ref) => `${ref.kind}:${ref.id}`;
  const validRef = (ref) =>
    ref && (ref.kind === 'session' || ref.kind === 'webview') && typeof ref.id === 'string' && ref.id.length > 0;
  const asIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []);
  const stableIds = (value) => [...new Set(asIds(value))];
  const COLLAPSED_STORAGE_KEY = 'codeman:tab-groups-collapsed';
  const FOCUS_COLLAPSED_STORAGE_KEY = 'codeman:focus-group-collapsed';

  function loadCollapsedGroupIds(storage, validGroupIds) {
    try {
      const raw = storage.getItem(COLLAPSED_STORAGE_KEY);
      const parsed = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid collapsed tab groups');
      const loaded = stableIds(parsed);
      if (validGroupIds === undefined) return { ids: loaded, ok: true };
      const valid = new Set(stableIds(validGroupIds));
      const kept = loaded.filter((id) => valid.has(id));
      if (kept.length !== loaded.length) storage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(kept));
      return { ids: kept, ok: true };
    } catch (_error) {
      return { ids: [], ok: false };
    }
  }

  function saveCollapsedGroupIds(storage, groupIds) {
    const ids = stableIds(groupIds);
    try {
      storage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(ids));
      return { ids, ok: true };
    } catch (_error) {
      return { ids: [], ok: false };
    }
  }

  function loadFocusGroupCollapsed(storage) {
    try {
      const raw = storage.getItem(FOCUS_COLLAPSED_STORAGE_KEY);
      if (raw === null || raw === 'false') return { collapsed: false, ok: true };
      if (raw === 'true') return { collapsed: true, ok: true };
      throw new Error('Invalid Focus collapse state');
    } catch (_error) {
      return { collapsed: false, ok: false };
    }
  }

  function saveFocusGroupCollapsed(storage, collapsed) {
    try {
      storage.setItem(FOCUS_COLLAPSED_STORAGE_KEY, collapsed === true ? 'true' : 'false');
      return { collapsed: collapsed === true, ok: true };
    } catch (_error) {
      return { collapsed: false, ok: false };
    }
  }

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
          ? group.refs.filter(validRef).map((ref) => ({
              kind: ref.kind,
              id: ref.id,
              ...(ref.placement === 'manual' ? { placement: 'manual' } : {}),
              ...(ref.focus === true ? { focus: true } : {}),
            }))
          : [],
      })),
      ungrouped: ungrouped.filter(validRef).map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        ...(ref.placement === 'manual' ? { placement: 'manual' } : {}),
        ...(ref.focus === true ? { focus: true } : {}),
      })),
    };
  }

  function operationError(message) {
    throw new Error(`Tab layout edit failed: ${message}`);
  }

  function boundedIndex(value, length) {
    if (!Number.isInteger(value) || value < 0 || value > length) operationError('invalid destination');
    return value;
  }

  function refLocations(layout) {
    return [
      ...layout.groups.flatMap((group) => group.refs.map((ref) => ({ groupId: group.id, ref }))),
      ...layout.ungrouped.map((ref) => ({ groupId: null, ref })),
    ];
  }

  function mapStoredRef(layout, target, transform) {
    const targetKey = refKey(target);
    let found = false;
    const apply = (ref) => {
      if (refKey(ref) !== targetKey) return ref;
      found = true;
      return transform(ref);
    };
    layout.groups = layout.groups.map((group) => ({ ...group, refs: group.refs.map(apply) }));
    layout.ungrouped = layout.ungrouped.map(apply);
    if (!found) operationError('unknown ref');
    return layout;
  }

  function inheritedDescendantKeys(layout, target, metadata) {
    const stored = new Map(refLocations(layout).map((item) => [refKey(item.ref), item.ref]));
    const children = new Map();
    for (const item of Array.isArray(metadata) ? metadata : []) {
      if (item?.kind !== 'session' || !item.parentSessionId) continue;
      const child = stored.get(refKey(item));
      const parentKey = refKey({ kind: 'session', id: item.parentSessionId });
      if (!child || child.placement === 'manual' || !stored.has(parentKey)) continue;
      const siblings = children.get(item.parentSessionId) || [];
      siblings.push(item.id);
      children.set(item.parentSessionId, siblings);
    }
    const result = new Set();
    const visit = (ref) => {
      const key = refKey(ref);
      if (result.has(key)) return;
      result.add(key);
      if (ref.kind === 'session') {
        for (const childId of children.get(ref.id) || []) visit({ kind: 'session', id: childId });
      }
    };
    visit(target);
    return result;
  }

  function previewOperation(layoutInput, operation) {
    const layout = normalizedLayout(layoutInput);
    if (operation?.type !== 'moveRef' || !validRef(operation.ref)) return { refs: [], operation };
    const keys = inheritedDescendantKeys(layout, operation.ref, operation.metadata);
    return {
      refs: refLocations(layout)
        .filter((item) => keys.has(refKey(item.ref)))
        .map((item) => ({ ...item.ref })),
      operation,
    };
  }

  function applyOperation(layoutInput, operation) {
    let layout = normalizedLayout(layoutInput);
    if (!operation || typeof operation.type !== 'string') operationError('missing operation');
    if (operation.type === 'createGroup') {
      if (!operation.id) operationError('invalid group id');
      const name = String(operation.name || '').trim();
      if (!name || name.length > 60) operationError('group name must be 1–60 characters');
      const existing = layout.groups.find((group) => group.id === operation.id);
      if (existing) {
        if (existing.name === name) return layout;
        operationError('invalid group id');
      }
      if (layout.groups.length >= 32) operationError('group limit reached');
      layout.groups.splice(boundedIndex(operation.index ?? layout.groups.length, layout.groups.length), 0, {
        id: operation.id,
        name,
        refs: [],
      });
      return layout;
    }
    const groupIndex = layout.groups.findIndex((group) => group.id === (operation.groupId || operation.id));
    if (operation.type === 'renameGroup') {
      if (groupIndex < 0) operationError('unknown group');
      const name = String(operation.name || '').trim();
      if (!name || name.length > 60) operationError('group name must be 1–60 characters');
      layout.groups[groupIndex].name = name;
      return layout;
    }
    if (operation.type === 'deleteGroup') {
      if (groupIndex < 0) return layout;
      const [removed] = layout.groups.splice(groupIndex, 1);
      layout.ungrouped.push(...removed.refs);
      return layout;
    }
    if (operation.type === 'reorderGroup') {
      if (groupIndex < 0) operationError('unknown group');
      const [moved] = layout.groups.splice(groupIndex, 1);
      layout.groups.splice(boundedIndex(operation.index, layout.groups.length), 0, moved);
      return layout;
    }
    if (operation.type === 'moveRef') {
      if (!validRef(operation.ref)) operationError('invalid ref');
      if (operation.groupId !== null && !layout.groups.some((group) => group.id === operation.groupId)) {
        operationError('unknown destination group');
      }
      const locations = refLocations(layout);
      const targetKey = refKey(operation.ref);
      if (!locations.some((item) => refKey(item.ref) === targetKey)) operationError('unknown ref');
      const blockKeys = inheritedDescendantKeys(layout, operation.ref, operation.metadata);
      const block = locations.filter((item) => blockKeys.has(refKey(item.ref))).map((item) => ({ ...item.ref }));
      const meta = (Array.isArray(operation.metadata) ? operation.metadata : []).find(
        (item) => refKey(item) === targetKey
      );
      if (operation.ref.kind === 'session' && meta?.parentSessionId) block[0].placement = 'manual';
      for (const group of layout.groups) group.refs = group.refs.filter((ref) => !blockKeys.has(refKey(ref)));
      layout.ungrouped = layout.ungrouped.filter((ref) => !blockKeys.has(refKey(ref)));
      const destination =
        operation.groupId === null
          ? layout.ungrouped
          : layout.groups.find((group) => group.id === operation.groupId).refs;
      destination.splice(boundedIndex(operation.index, destination.length), 0, ...block);
      return layout;
    }
    if (operation.type === 'setManualPlacement') {
      if (!validRef(operation.ref) || operation.manual !== true) operationError('invalid manual placement');
      return mapStoredRef(layout, operation.ref, (ref) => ({ ...ref, placement: 'manual' }));
    }
    if (operation.type === 'setFocus') {
      if (!validRef(operation.ref) || typeof operation.focused !== 'boolean') operationError('invalid Focus state');
      return mapStoredRef(layout, operation.ref, (ref) => {
        if (operation.focused) return { ...ref, focus: true };
        const { focus: _focus, ...rest } = ref;
        return rest;
      });
    }
    if (operation.type === 'followParent') {
      if (!validRef(operation.ref) || operation.ref.kind !== 'session') operationError('only a session can follow');
      if (!refLocations(layout).some((item) => refKey(item.ref) === refKey(operation.ref)))
        operationError('unknown ref');
      return layout;
    }
    operationError(`unknown operation ${operation.type}`);
  }

  function layoutContentKey(layoutInput) {
    const layout = normalizedLayout(layoutInput);
    return JSON.stringify({ groups: layout.groups, ungrouped: layout.ungrouped });
  }

  function operationsAfterAppliedPrefix(baseLayout, operationsInput, currentLayout, authoritativeAppliedCount) {
    const operations = Array.isArray(operationsInput) ? operationsInput : [];
    if (
      Number.isSafeInteger(authoritativeAppliedCount) &&
      authoritativeAppliedCount >= 0 &&
      authoritativeAppliedCount <= operations.length
    ) {
      return operations.slice(authoritativeAppliedCount);
    }
    const currentKey = layoutContentKey(currentLayout);
    let candidate = normalizedLayout(baseLayout);
    let appliedCount = layoutContentKey(candidate) === currentKey ? 0 : -1;
    for (let index = 0; index < operations.length; index++) {
      // Follow-parent is a server-authoritative lineage operation. Skip its
      // derivation but keep scanning ordinary suffix operations. Shipping
      // responses provide the exact authoritative prefix count when Follow
      // changed structure; this fallback remains useful with older responses.
      if (operations[index]?.type === 'followParent') continue;
      candidate = applyOperation(candidate, operations[index]);
      if (layoutContentKey(candidate) === currentKey) appliedCount = index + 1;
    }
    return operations.slice(appliedCount < 0 ? 0 : appliedCount);
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
    const completeRefs = [];
    const completeSeen = new Set();
    const visibleRefs = [];
    const focusRefs = [];
    const sections = [];
    const hiddenTabGroupByRef = {};

    const renderable = (ref) => (ref.kind === 'session' ? liveSessionIds.has(ref.id) : openWebviewIds.has(ref.id));
    if (orientation === 'vertical') {
      for (const { ref } of refLocations(layout)) {
        if (ref.focus === true && renderable(ref)) focusRefs.push({ kind: ref.kind, id: ref.id });
      }
    }
    const addVisible = (ref, sectionRefs, isCollapsed, groupId = null, stored = true) => {
      const key = refKey(ref);
      if (stored) {
        if (processedStoredKeys.has(key)) return false;
        processedStoredKeys.add(key);
      } else if (storedKeys.has(key)) {
        return false;
      }
      if (!renderable(ref)) return false;
      if (!completeSeen.has(key)) {
        completeSeen.add(key);
        completeRefs.push({ kind: ref.kind, id: ref.id });
      }
      if (seen.has(key)) return false;
      if (orientation === 'vertical' && isCollapsed && key !== highlighted) {
        if (groupId) hiddenTabGroupByRef[key] = groupId;
        return false;
      }
      seen.add(key);
      const copy = { kind: ref.kind, id: ref.id };
      visibleRefs.push(copy);
      sectionRefs.push(copy);
      return true;
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
      const refIndices = [];
      const isCollapsed = collapsed.has(group.id);
      group.refs.forEach((ref, storedIndex) => {
        if (addVisible(ref, refs, isCollapsed, group.id)) refIndices.push(storedIndex);
      });
      if (orientation === 'vertical') {
        sections.push({
          id: group.id,
          name: group.name,
          refs,
          refIndices,
          count: group.refs.length,
          collapsed: isCollapsed,
        });
      }
    }
    const ungroupedRefs = [];
    const ungroupedRefIndices = [];
    layout.ungrouped.forEach((ref, storedIndex) => {
      if (addVisible(ref, ungroupedRefs, false, null)) ungroupedRefIndices.push(storedIndex);
    });

    // A newly opened local webview or live session may predate server
    // reconciliation. Append omissions deterministically without moving saved refs.
    for (const id of ownerSessions) {
      if (addVisible({ kind: 'session', id }, ungroupedRefs, false, null, false)) {
        ungroupedRefIndices.push(layout.ungrouped.length);
      }
    }
    for (const id of openWebviewIds) {
      if (addVisible({ kind: 'webview', id }, ungroupedRefs, false, null, false)) {
        ungroupedRefIndices.push(layout.ungrouped.length);
      }
    }
    if (orientation === 'vertical') {
      sections.push({
        id: null,
        name: '',
        refs: ungroupedRefs,
        refIndices: ungroupedRefIndices,
        count: layout.ungrouped.length,
        collapsed: false,
      });
    }

    return {
      sessionOrder: ownerSessions,
      completeRefs,
      visibleRefs,
      focusRefs,
      focusCollapsed: orientation === 'vertical' && options.focusCollapsed === true,
      sections,
      hiddenTabGroupByRef,
    };
  }

  function filterSessionProjection(projection, matchingSessionIds) {
    const matches = new Set(asIds(matchingSessionIds));
    const keep = (ref) => ref?.kind === 'session' && matches.has(ref.id);
    const sections = (Array.isArray(projection?.sections) ? projection.sections : [])
      .map((section) => {
        const refs = [];
        const refIndices = [];
        (Array.isArray(section.refs) ? section.refs : []).forEach((ref, index) => {
          if (!keep(ref)) return;
          refs.push({ kind: ref.kind, id: ref.id });
          refIndices.push(section.refIndices?.[index] ?? index);
        });
        return { ...section, refs, refIndices, count: refs.length, collapsed: false };
      })
      .filter((section) => section.refs.length > 0);
    const visibleRefs = (Array.isArray(projection?.visibleRefs) ? projection.visibleRefs : [])
      .filter(keep)
      .map((ref) => ({ kind: ref.kind, id: ref.id }));
    const focusRefs = (Array.isArray(projection?.focusRefs) ? projection.focusRefs : [])
      .filter(keep)
      .map((ref) => ({ kind: ref.kind, id: ref.id }));
    return {
      ...projection,
      visibleRefs,
      focusRefs,
      focusCollapsed: false,
      sections,
      hiddenTabGroupByRef: {},
      searchActive: true,
      matchCount: new Set([...visibleRefs, ...focusRefs].map((ref) => ref.id)).size,
    };
  }

  function projectFallback(options = {}) {
    const legacy = stableIds(options.legacySessionOrder);
    const live = stableIds(options.liveSessionIds);
    const sessionOrder = [...legacy.filter((id) => live.includes(id)), ...live.filter((id) => !legacy.includes(id))];
    const visibleRefs = [
      ...sessionOrder.map((id) => ({ kind: 'session', id })),
      ...stableIds(options.openWebviewIds).map((id) => ({ kind: 'webview', id })),
    ];
    return {
      sessionOrder,
      completeRefs: visibleRefs.map((ref) => ({ ...ref })),
      visibleRefs,
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
      focusCollapsed: input.focusCollapsed === true,
      focusRefs: (Array.isArray(input.focusRefs) ? input.focusRefs : []).filter(validRef).map(refKey),
      placementStates: Array.isArray(input.placementStates) ? input.placementStates : [],
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

  function renderProjection(projection, orientation, renderRef, escapeHtml, renderFocusRef = renderRef) {
    const refs = Array.isArray(projection?.visibleRefs) ? projection.visibleRefs : [];
    const sections = Array.isArray(projection?.sections) ? projection.sections : [];
    if (orientation !== 'vertical' || sections.length === 0) {
      return refs.map((ref, index) => renderRef(ref, index)).join('');
    }
    const focusRefs = Array.isArray(projection?.focusRefs) ? projection.focusRefs : [];
    const focusCollapsed = projection?.focusCollapsed === true;
    const focusContent = focusCollapsed
      ? ''
      : focusRefs
          .map((ref) => {
            let rendered = renderFocusRef(ref, -1, { focusShortcut: true })
              .replace(/role="tab"/, 'role="treeitem"')
              .replace(/tabindex="0"/g, 'tabindex="-1"')
              .replace(/<button(?![^>]*tabindex)/g, '<button tabindex="-1"');
            if (!/role="treeitem"/.test(rendered)) rendered = rendered.replace(/^<([a-z]+)/, '<$1 role="treeitem"');
            return rendered;
          })
          .join('');
    const focus = focusRefs.length
      ? `<section class="tab-layout-group tab-layout-focus-group" role="presentation" data-tab-focus-group><div class="tab-layout-group-header tab-layout-focus-header" role="treeitem" tabindex="-1" aria-labelledby="tab-focus-header" aria-expanded="${focusCollapsed ? 'false' : 'true'}"><button type="button" tabindex="-1" class="tab-layout-group-toggle" data-tab-focus-toggle aria-label="${focusCollapsed ? 'Expand' : 'Collapse'} Focus" aria-expanded="${focusCollapsed ? 'false' : 'true'}" onclick="app.toggleFocusGroupCollapsed()"><span class="tab-layout-group-chevron" aria-hidden="true"></span></button><span id="tab-focus-header" class="tab-layout-group-name tab-layout-group-label" data-i18n-skip>Focus</span><span class="tab-layout-group-count">${focusRefs.length}</span></div>${focusCollapsed ? '' : `<div class="tab-layout-group-refs" role="group" aria-labelledby="tab-focus-header">${focusContent}</div>`}</section>`
      : '';
    let index = 0;
    const groups = sections
      .map((section, sectionIndex) => {
        const name = section.id === null ? 'Ungrouped' : section.name;
        const content = (Array.isArray(section.refs) ? section.refs : [])
          .map((ref, refIndex) => {
            let rendered = renderRef(ref, index++)
              .replace(/role="tab"/, 'role="treeitem"')
              .replace(/tabindex="0"/g, 'tabindex="-1"')
              .replace(/<button(?![^>]*tabindex)/g, '<button tabindex="-1"');
            if (!/role="treeitem"/.test(rendered)) rendered = rendered.replace(/^<([a-z]+)/, '<$1 role="treeitem"');
            const storedIndex = section.refIndices?.[refIndex] ?? refIndex;
            return `<div class="tab-layout-drop-zone" role="presentation" data-tab-drop-group="${escapeHtml(section.id || '')}" data-tab-drop-index="${storedIndex}"></div>${rendered}`;
          })
          .join('');
        const headerId = section.id === null ? '' : `tab-group-header-${sectionIndex}`;
        const header =
          section.id === null
            ? `<div class="tab-layout-ungrouped-header" role="treeitem" tabindex="-1"><span class="tab-layout-group-name">${escapeHtml(name)}</span><span class="tab-layout-group-count">${section.count ?? section.refs.length}</span></div>`
            : `<div class="tab-layout-group-header" role="treeitem" tabindex="-1" aria-labelledby="${escapeHtml(headerId)}" aria-expanded="${section.collapsed ? 'false' : 'true'}"><button type="button" tabindex="-1" class="tab-layout-group-toggle" data-tab-group-header="${escapeHtml(section.id)}" aria-label="${section.collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(name)}" aria-expanded="${section.collapsed ? 'false' : 'true'}" onclick="app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)"><span class="tab-layout-group-chevron" aria-hidden="true"></span></button><span id="${escapeHtml(headerId)}" class="tab-layout-group-name tab-layout-group-label" data-i18n-skip>${escapeHtml(name)}</span><span class="tab-layout-group-count">${section.count ?? section.refs.length}</span><button type="button" tabindex="-1" class="tab-layout-group-drag-handle" aria-label="Move ${escapeHtml(name)}" data-tab-group-drag="${escapeHtml(section.id)}">&#x2630;</button><button type="button" tabindex="-1" class="tab-layout-group-menu" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false" onclick="app.openTabGroupMenu(event, this.closest('.tab-layout-group-header').querySelector('[data-tab-group-header]').dataset.tabGroupHeader)">&#x22EF;</button></div>`;
        const label =
          section.id === null ? `aria-label="${escapeHtml(name)}"` : `aria-labelledby="${escapeHtml(headerId)}"`;
        const members = section.collapsed
          ? `<div class="tab-layout-group-refs tab-layout-collapsed-exception" role="presentation"${section.refs.length ? ` data-tab-highlighted-exception="${escapeHtml(section.id)}"` : ''}>${content}<div class="tab-layout-drop-zone" role="presentation" data-tab-drop-group="${escapeHtml(section.id || '')}" data-tab-drop-index="${section.count ?? section.refs.length}"></div></div>`
          : `<div class="tab-layout-group-refs" role="group" ${label}>${content}<div class="tab-layout-drop-zone" role="presentation" data-tab-drop-group="${escapeHtml(section.id || '')}" data-tab-drop-index="${section.count ?? section.refs.length}"></div></div>`;
        return `<div class="tab-layout-drop-zone" role="presentation" data-tab-drop-before-group="${escapeHtml(section.id || '')}"></div><section class="tab-layout-group" role="presentation" data-tab-group-id="${escapeHtml(section.id || '')}">${header}${members}</section>`;
      })
      .join('');
    return `<div class="tab-layout-tree" role="tree" aria-label="Sessions">${focus}${groups}</div><button type="button" tabindex="-1" class="tab-layout-create-group" onclick="app.createTabGroup()">Create group</button>`;
  }

  function createEditCoordinator(options) {
    let authoritative = normalizedLayout(options.initialLayout);
    let optimistic = normalizedLayout(authoritative);
    let pending = [];
    let pendingRecoveryBase = null;
    let inFlight = null;
    let inFlightBase = null;
    let inFlightRecoveryBase = null;
    let timer = null;
    let writing = false;
    let generation = 0;
    const schedule = options.schedule || setTimeout;
    const cancel = options.cancel || clearTimeout;
    const apply = (layout, meta) => options.applyLayout?.(normalizedLayout(layout), meta);
    const report = (message) => options.reportError?.(message);

    const replay = (base, operations) =>
      operations.reduce((current, operation) => applyOperation(current, operation), base);
    const stopAndAdopt = (layout, placements) => {
      if (timer !== null) cancel(timer);
      timer = null;
      pending = [];
      pendingRecoveryBase = null;
      authoritative = normalizedLayout(layout);
      optimistic = normalizedLayout(authoritative);
      apply(optimistic, { authoritative: true, authoritativeLayout: authoritative, placements });
    };
    const flush = async () => {
      timer = null;
      if (writing || pending.length === 0) return;
      writing = true;
      const batch = pending;
      pending = [];
      const recoveryBase = pendingRecoveryBase;
      pendingRecoveryBase = null;
      inFlight = batch;
      const requestGeneration = ++generation;
      let base = normalizedLayout(authoritative);
      const requestBase = recoveryBase ? normalizedLayout(recoveryBase) : base;
      inFlightBase = requestBase;
      inFlightRecoveryBase = recoveryBase ? requestBase : null;
      let desired;
      try {
        desired = recoveryBase ? normalizedLayout(optimistic) : replay(base, batch);
        let response = await options.put({
          baseVersion: requestBase.version,
          layout: desired,
          operations: batch,
          recoveryBaseLayout: requestBase,
        });
        if (requestGeneration !== generation) return;
        if (!response.ok && response.status === 409 && response.layout) {
          const remaining = operationsAfterAppliedPrefix(
            requestBase,
            batch,
            response.layout,
            response.appliedOperationCount
          );
          base = normalizedLayout(response.layout);
          inFlight = remaining;
          inFlightBase = base;
          inFlightRecoveryBase = null;
          if (remaining.length === 0) {
            authoritative = base;
            optimistic = pending.length ? replay(authoritative, pending) : normalizedLayout(authoritative);
            apply(optimistic, {
              authoritative: true,
              authoritativeLayout: authoritative,
              placements: response.placements,
              committedOperations: batch,
            });
            return;
          }
          try {
            desired = replay(base, remaining);
          } catch (_error) {
            stopAndAdopt(base, response.placements);
            report('Tab layout changed; your edit could not be reapplied.');
            return;
          }
          response = await options.put({
            baseVersion: base.version,
            layout: desired,
            operations: remaining,
            recoveryBaseLayout: base,
          });
          if (requestGeneration !== generation) return;
          if (!response.ok && response.status === 409 && response.layout) {
            stopAndAdopt(response.layout, response.placements);
            report('Tab layout changed again; server layout restored.');
            return;
          }
        }
        if (!response.ok || !response.layout) {
          stopAndAdopt(response.layout || base, response.placements);
          report('Could not save tab layout.');
          return;
        }
        authoritative = normalizedLayout(response.layout);
        optimistic = pending.length ? replay(authoritative, pending) : normalizedLayout(authoritative);
        apply(optimistic, {
          authoritative: true,
          authoritativeLayout: authoritative,
          placements: response.placements,
          committedOperations: batch,
        });
      } catch (_error) {
        stopAndAdopt(authoritative);
        report('Could not save tab layout.');
      } finally {
        if (requestGeneration === generation) {
          inFlight = null;
          inFlightBase = null;
          inFlightRecoveryBase = null;
          writing = false;
          if (pending.length) queue();
          else options.onSettled?.();
        }
      }
    };
    const queue = () => {
      if (timer !== null) cancel(timer);
      timer = schedule(flush, options.debounceMs ?? 180);
    };
    return {
      enqueue(operation) {
        optimistic = applyOperation(optimistic, operation);
        pending.push(operation);
        apply(optimistic, { optimistic: true, operation });
        queue();
        return normalizedLayout(optimistic);
      },
      restoreOperations(baseLayout, operationsInput) {
        const operations = Array.isArray(operationsInput) ? operationsInput : [];
        if (!operations.length) return false;
        pendingRecoveryBase = normalizedLayout(baseLayout);
        pending.push(...operations);
        queue();
        return true;
      },
      flush,
      getLayout: () => normalizedLayout(optimistic),
      hasPending: () => writing || pending.length > 0,
      pendingOperations: () => JSON.parse(JSON.stringify([...(inFlight || []), ...pending])),
      recoverySnapshot: () => ({
        baseLayout: normalizedLayout(inFlightBase || pendingRecoveryBase || authoritative),
        operations: JSON.parse(JSON.stringify([...(inFlight || []), ...pending])),
      }),
      flushKeepalive() {
        if (!options.putKeepalive || (!writing && pending.length === 0)) return false;
        if (timer !== null) cancel(timer);
        timer = null;
        const recoveryBase = inFlightBase || pendingRecoveryBase;
        options.putKeepalive({
          baseVersion: (recoveryBase || authoritative).version,
          layout: normalizedLayout(optimistic),
          operations: JSON.parse(JSON.stringify([...(inFlight || []), ...pending])),
          ...(recoveryBase ? { recoveryBaseLayout: normalizedLayout(recoveryBase) } : {}),
        });
        return true;
      },
      adoptExternal(layout, meta = {}) {
        const next = normalizedLayout(layout);
        if (next.version < authoritative.version) return false;
        generation++;
        if (inFlight?.length) {
          pending = [...inFlight, ...pending];
          pendingRecoveryBase = inFlightRecoveryBase;
        }
        inFlight = null;
        inFlightBase = null;
        inFlightRecoveryBase = null;
        writing = false;
        authoritative = next;
        try {
          optimistic = pendingRecoveryBase
            ? normalizedLayout(next)
            : pending.length
              ? replay(next, pending)
              : normalizedLayout(next);
        } catch (_error) {
          pending = [];
          optimistic = normalizedLayout(next);
          report('Tab layout changed; your pending edit was discarded.');
        }
        apply(optimistic, {
          authoritative: true,
          authoritativeLayout: authoritative,
          external: true,
          placements: meta.placements,
        });
        if (pending.length) queue();
        return true;
      },
      dispose() {
        generation++;
        if (timer !== null) cancel(timer);
        timer = null;
        pending = [];
        pendingRecoveryBase = null;
        inFlight = null;
        inFlightRecoveryBase = null;
        writing = false;
      },
    };
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
    filterSessionProjection,
    projectFallback,
    collapsedHash,
    structureKey,
    refAtAltNumber,
    adjacentSession,
    renderProjection,
    applyOperation,
    operationsAfterAppliedPrefix,
    previewOperation,
    createEditCoordinator,
    createLoadCoordinator,
    loadCollapsedGroupIds,
    saveCollapsedGroupIds,
    loadFocusGroupCollapsed,
    saveFocusGroupCollapsed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
