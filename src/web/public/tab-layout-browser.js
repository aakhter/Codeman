/**
 * @fileoverview Browser projection and editing of the owner tab layout.
 *
 * `GET /api/tab-layout` returns the owner's named tab GROUPS (`src/tab-layout.ts`
 * is the server model). Browser assets cannot import that TypeScript, so this
 * module is a small, dependency-free mirror that owns four things:
 *
 *  1. Projection: which live sessions and open web tabs land in which group,
 *     and which rows a collapsed group hides.
 *  2. Rendering: the grouped markup for the vertical tab rail. Rows themselves
 *     are rendered by the caller (app.js, webview-tabs.js), so a grouped row is
 *     byte-identical to the flat rail's row.
 *  3. Load sequencing: concurrent layout reads settle newest-wins, and a failed
 *     read degrades to the flat rail with a capped, backed-off retry.
 *  4. Editing: named operations (create/rename/delete/reorder a group, move a
 *     row, pin a row to Focus) applied optimistically and saved through ONE serialized
 *     `PUT /api/tab-layout` at a time, rebased onto the server's layout on a
 *     version conflict.
 *
 * The server stays the only authority for layout content. Collapse is a
 * per-device view preference and lives in localStorage only.
 *
 * Grouped rendering is opt-in by construction: a layout with no groups (every
 * owner until they create one) projects to `null`, and the caller keeps the flat
 * rail exactly as it was.
 *
 * @dependency none
 * @loadorder 5.9 (before app.js, which reads window.CodemanTabLayout)
 */

(function initCodemanTabLayout(global) {
  'use strict';

  const COLLAPSED_STORAGE_KEY = 'codeman:tab-groups-collapsed';

  const refKey = (ref) => `${ref.kind}:${ref.id}`;
  const validRef = (ref) =>
    !!ref && (ref.kind === 'session' || ref.kind === 'webview') && typeof ref.id === 'string' && ref.id.length > 0;
  const asIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []);
  const stableIds = (value) => [...new Set(asIds(value))];
  // `placement: 'manual'` and `focus: true` must survive the round trip: the
  // browser writes whole layouts back, and dropping either would re-attach a
  // hand-placed child session to its parent's subtree, or empty Focus, on the
  // next save of any unrelated edit.
  const copyRef = (r) => ({
    kind: r.kind,
    id: r.id,
    ...(r.placement === 'manual' ? { placement: 'manual' } : {}),
    ...(r.focus === true ? { focus: true } : {}),
  });
  const copyRefs = (value) => (Array.isArray(value) ? value.filter(validRef).map(copyRef) : []);
  const bareRef = (r) => ({ kind: r.kind, id: r.id });
  const uniqueBareRefs = (value) => {
    const seen = new Set();
    const result = [];
    for (const ref of Array.isArray(value) ? value.filter(validRef) : []) {
      if (seen.has(refKey(ref))) continue;
      seen.add(refKey(ref));
      result.push(bareRef(ref));
    }
    return result;
  };

  /**
   * The Focus list's id in drag targets (dropOperation) and in the collapse
   * toggle's routing. Not a stored group: an id the client's UUID group ids
   * never take. Focus itself is a list of shortcuts (COD-525), never a section.
   */
  const FOCUS_SECTION_ID = ':focus';
  const FOCUS_COLLAPSED_STORAGE_KEY = 'codeman:focus-group-collapsed';

  /** Server limits (src/tab-layout.ts), mirrored so a bad edit fails before the PUT. */
  const MAX_GROUPS = 32;
  const MAX_NAME_LENGTH = 60;

  /**
   * Defensive copy of a server layout. Unknown fields are dropped, so a newer
   * server adding model fields cannot leak half-understood state into the view.
   */
  function normalizeLayout(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid tab layout');
    const groups = Array.isArray(value.groups) ? value.groups : [];
    return {
      version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      groups: groups
        .filter((group) => group && typeof group.id === 'string' && group.id.length > 0)
        .map((group) => ({
          id: group.id,
          name: typeof group.name === 'string' ? group.name : '',
          refs: copyRefs(group.refs),
        })),
      ungrouped: copyRefs(value.ungrouped),
      ...(Array.isArray(value.focusOrder) ? { focusOrder: uniqueBareRefs(value.focusOrder) } : {}),
    };
  }

  /**
   * Focus order: explicitly ordered focused refs first, then focused refs the
   * order does not list yet, in stored position order. Mirrors orderedFocusRefs()
   * in src/tab-layout.ts. `accept(ref)` narrows to what can be drawn here.
   */
  function orderedFocusRefs(layoutInput, accept) {
    const layout = normalizeLayout(layoutInput);
    const focused = new Map();
    for (const { ref } of refLocations(layout)) {
      if (ref.focus === true && !focused.has(refKey(ref))) focused.set(refKey(ref), bareRef(ref));
    }
    const result = [];
    const emitted = new Set();
    for (const ref of [...(layout.focusOrder || []), ...focused.values()]) {
      const key = refKey(ref);
      if (!focused.has(key) || emitted.has(key)) continue;
      emitted.add(key);
      result.push(focused.get(key));
    }
    return accept ? result.filter(accept) : result;
  }

  /** Drop Focus order entries that are no longer stored or no longer focused. */
  function prunedFocusOrder(layout) {
    if (!Array.isArray(layout.focusOrder)) return layout;
    const focusedKeys = new Set(
      refLocations(layout)
        .filter((item) => item.ref.focus === true)
        .map((item) => refKey(item.ref))
    );
    const kept = layout.focusOrder.filter((ref) => focusedKeys.has(refKey(ref)));
    if (kept.length === layout.focusOrder.length) return layout;
    if (kept.length === 0) {
      const { focusOrder: _dropped, ...rest } = layout;
      return rest;
    }
    return { ...layout, focusOrder: kept };
  }

  function hasFocus(layout) {
    return !!layout && refLocations(layout).some((item) => item.ref.focus === true);
  }

  /**
   * Placement facts for every stored child session, the browser twin of
   * describeTabPlacements() in src/tab-layout.ts: `inherited` (follows its
   * parent), `manual` (moved by hand, can follow again), `dangling` (parent gone
   * from the layout) or `cycle`. Computed here rather than read from the server
   * so the badge tracks the optimistic layout an edit just painted.
   * `parents` maps a session id to its parent session id.
   */
  function describePlacements(layoutInput, parents) {
    const layout = normalizeLayout(layoutInput);
    const located = refLocations(layout);
    const represented = new Set(located.map((item) => refKey(item.ref)));
    const parentOf = parents || {};
    const cycleIds = new Set();
    const state = new Map();
    const stack = [];
    const visit = (id) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') {
        for (const cycleId of stack.slice(Math.max(0, stack.indexOf(id)))) cycleIds.add(cycleId);
        return;
      }
      state.set(id, 'visiting');
      stack.push(id);
      const parentId = parentOf[id];
      if (parentId && represented.has(`session:${parentId}`)) visit(parentId);
      stack.pop();
      state.set(id, 'done');
    };
    for (const { ref } of located) if (ref.kind === 'session') visit(ref.id);
    const result = {};
    for (const { ref } of located) {
      if (ref.kind !== 'session') continue;
      const parentId = parentOf[ref.id];
      if (typeof parentId !== 'string' || !parentId || parentId === ref.id) continue;
      const placementState = !represented.has(`session:${parentId}`)
        ? 'dangling'
        : cycleIds.has(ref.id)
          ? 'cycle'
          : ref.placement === 'manual'
            ? 'manual'
            : 'inherited';
      result[refKey(ref)] = { state: placementState, parentId, canFollow: placementState === 'manual' };
    }
    return result;
  }

  function hasGroups(layout) {
    return !!layout && Array.isArray(layout.groups) && layout.groups.length > 0;
  }

  /** Stored collapse ids, or null when the stored value is not a JSON array. */
  function parseCollapsedIds(raw) {
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? stableIds(parsed) : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Read the per-device collapse ids. `ok: false` means the STORE failed (a read
   * or write threw), and the caller then keeps every group expanded. A malformed
   * VALUE is not a store failure: it reads as "nothing collapsed" and is
   * rewritten, or a shape left behind by another build (a rollback) would leave
   * collapse disabled on this device for good.
   */
  function loadCollapsedGroupIds(storage, validGroupIds) {
    try {
      const parsed = parseCollapsedIds(storage.getItem(COLLAPSED_STORAGE_KEY));
      const loaded = parsed || [];
      if (validGroupIds === undefined) return { ids: loaded, ok: true };
      // Garbage-collect ids of groups that no longer exist, so a deleted group's
      // id cannot silently collapse a future group that reuses it.
      const valid = new Set(stableIds(validGroupIds));
      const kept = loaded.filter((id) => valid.has(id));
      if (!parsed || kept.length !== loaded.length) storage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(kept));
      return { ids: kept, ok: true };
    } catch (_error) {
      return { ids: [], ok: false };
    }
  }

  /**
   * The refs pinned to the Focus section that this browser can draw: focused,
   * a live session or an open web tab, each once, in stored order (groups in
   * order, then Ungrouped). Works with or without named groups, so Focus also
   * shows above the flat rail. A ref whose session closed or whose web tab is
   * not open here simply drops out; the server prunes deleted refs on its own.
   */
  function focusRefs(layoutInput, options = {}) {
    if (!layoutInput) return [];
    const layout = normalizeLayout(layoutInput);
    const live = new Set(asIds(options.liveSessionIds));
    const open = new Set(asIds(options.openWebviewIds));
    const seen = new Set();
    const result = [];
    for (const ref of [...layout.groups.flatMap((group) => group.refs), ...layout.ungrouped]) {
      if (ref.focus !== true) continue;
      if (!(ref.kind === 'session' ? live.has(ref.id) : open.has(ref.id))) continue;
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ kind: ref.kind, id: ref.id });
    }
    return result;
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

  /** Per-device Focus collapse. A store failure reads as expanded. */
  function loadFocusCollapsed(storage) {
    try {
      return storage.getItem(FOCUS_COLLAPSED_STORAGE_KEY) === 'true';
    } catch (_error) {
      return false;
    }
  }

  function saveFocusCollapsed(storage, collapsed) {
    try {
      storage.setItem(FOCUS_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Project a layout onto what is live in this browser.
   *
   * Every live session and open web tab appears exactly once: stored refs keep
   * their group and stored order; anything the layout has not caught up with yet
   * (a session created a moment ago, a web tab opened on this device only) is
   * appended to the ungrouped section in the caller's order. Saved web tabs that
   * are not open here are skipped, as are refs to sessions that are gone.
   *
   * A collapsed group hides its rows, EXCEPT the highlighted one (the active web
   * tab, else the active session), so selecting a hidden session by keyboard,
   * palette or Alt+N never leaves the user with no visible selection.
   *
   * `options.parents` (child session id -> parent session id) places a live
   * session the layout has not stored yet right after its parent's rows when
   * the parent IS stored: that is where the server puts a child that follows its
   * parent, so a spawned session appears in its parent's group at once instead
   * of jumping there from Ungrouped once the layout re-read lands.
   *
   * @returns {null | { sections, visibleRefs, hiddenTabGroupByRef, sectionByRef, focusRefs }}
   *   null when the layout has no groups: the caller renders the flat rail
   *   unchanged. Each section lists the rows it shows (`refs`) and the rows its
   *   collapse hides (`hidden`); `sectionByRef` maps every placed row
   *   (`<kind>:<id>`) to its section id (null = Ungrouped), shown or hidden.
   *   `focusRefs` is focusRefs() for the same options: shortcuts, never rows,
   *   so they are in none of the other fields.
   */
  function project(layoutInput, options = {}) {
    if (!layoutInput) return null;
    const layout = normalizeLayout(layoutInput);
    if (!hasGroups(layout) && !hasFocus(layout)) return null;
    const liveSessionIds = stableIds(options.liveSessionIds);
    const openWebviewIds = stableIds(options.openWebviewIds);
    const live = new Set(liveSessionIds);
    const open = new Set(openWebviewIds);
    const collapsed = new Set(asIds(options.collapsedGroupIds));
    const highlighted = options.activeWebviewId
      ? `webview:${options.activeWebviewId}`
      : options.activeSessionId
        ? `session:${options.activeSessionId}`
        : '';
    const renderable = (ref) => (ref.kind === 'session' ? live.has(ref.id) : open.has(ref.id));
    const withFollowers = followingChildren(layout, liveSessionIds, options.parents);
    const placed = new Set();
    const visibleRefs = [];
    const hiddenTabGroupByRef = {};
    const sectionByRef = {};
    const sections = [];

    const place = (refs, sectionId, isCollapsed) => {
      const shown = [];
      const hidden = [];
      let count = 0;
      for (const ref of refs) {
        const key = refKey(ref);
        if (placed.has(key) || !renderable(ref)) continue;
        placed.add(key);
        sectionByRef[key] = sectionId;
        count++;
        const copy = { kind: ref.kind, id: ref.id };
        if (isCollapsed && key !== highlighted) {
          hiddenTabGroupByRef[key] = sectionId;
          hidden.push(copy);
          continue;
        }
        shown.push(copy);
        visibleRefs.push(copy);
      }
      return { shown, hidden, count };
    };

    // Focus is a list of SHORTCUTS (COD-525), drawn by the caller above the
    // rail from `focusRefs`: a focused row stays in its own group at its own
    // position, so nothing is placed here and Focus is in no section field.
    const focusRefs = orderedFocusRefs(layout, renderable);
    if (!hasGroups(layout) && focusRefs.length === 0) return null;
    for (const group of layout.groups) {
      const isCollapsed = collapsed.has(group.id);
      const { shown, hidden, count } = place(withFollowers(group.refs), group.id, isCollapsed);
      sections.push({ id: group.id, name: group.name, refs: shown, hidden, count, collapsed: isCollapsed });
    }
    const omissions = [
      ...liveSessionIds.map((id) => ({ kind: 'session', id })),
      ...openWebviewIds.map((id) => ({ kind: 'webview', id })),
    ];
    const ungrouped = place([...withFollowers(layout.ungrouped), ...omissions], null, false);
    if (ungrouped.count > 0) {
      sections.push({
        id: null,
        name: '',
        refs: ungrouped.shown,
        hidden: [],
        count: ungrouped.count,
        collapsed: false,
        // With no named group the rest of the rail is not "ungrouped" from
        // anything: it is drawn without the divider.
        ...(hasGroups(layout) ? {} : { headless: true }),
      });
    }
    return { sections, visibleRefs, hiddenTabGroupByRef, sectionByRef, focusRefs };
  }

  /**
   * Alt+1..9 order: Focus first, then every other live session in tab order,
   * then open web tabs. Without Focus this is exactly the flat strip's numbering.
   */
  function altRefs(projection, liveSessionIds, openWebviewIds) {
    const focus = projection && Array.isArray(projection.focusRefs) ? projection.focusRefs : [];
    return uniqueBareRefs([
      ...focus,
      ...stableIds(liveSessionIds).map((id) => ({ kind: 'session', id })),
      ...stableIds(openWebviewIds).map((id) => ({ kind: 'webview', id })),
    ]);
  }

  /**
   * Narrow a projection to the matching sessions (a search or a filter), every
   * section open. Web tabs never match a session filter.
   */
  function filterSessionProjection(projection, matchingSessionIds) {
    if (!projection) return null;
    const matches = new Set(asIds(matchingSessionIds));
    const keep = (ref) => ref && ref.kind === 'session' && matches.has(ref.id);
    const sections = (projection.sections || [])
      .map((section) => {
        const refs = [...(section.refs || []), ...(section.hidden || [])].filter(keep).map(bareRef);
        return { ...section, refs, hidden: [], count: refs.length, collapsed: false };
      })
      .filter((section) => section.count > 0);
    const visibleRefs = sections.flatMap((section) => section.refs);
    return {
      ...projection,
      sections,
      visibleRefs,
      hiddenTabGroupByRef: {},
      focusRefs: (projection.focusRefs || []).filter(keep).map(bareRef),
    };
  }

  const ALERT_RANK = { action: 2, idle: 1 };

  /**
   * The most urgent alert behind each COLLAPSED header: `{ [groupId]: 'action' |
   * 'idle' }` over the session rows the collapse hides. A shown row (the kept
   * selection, any expanded group) draws its own alert, so it is not counted
   * here. `alertOf(sessionId)` is the caller's tab alert lookup.
   */
  function hiddenGroupAlerts(projection, alertOf) {
    const result = {};
    const sections = projection && Array.isArray(projection.sections) ? projection.sections : [];
    for (const section of sections) {
      if (section.id === null || !Array.isArray(section.hidden)) continue;
      let best = null;
      for (const ref of section.hidden) {
        if (ref.kind !== 'session') continue;
        const alert = alertOf(ref.id);
        if (ALERT_RANK[alert] && (!best || ALERT_RANK[alert] > ALERT_RANK[best])) best = alert;
      }
      if (best) result[section.id] = best;
    }
    return result;
  }

  /**
   * For project(): returns `expand(refs)`, which inserts each live, not-yet-stored
   * child session right after its parent's rows in the parent's container. A
   * child of such a child follows it the same way. Without `parents` it is the
   * identity, so callers that pass no lineage see no change.
   */
  function followingChildren(layout, liveSessionIds, parents) {
    if (!parents || typeof parents !== 'object') return (refs) => refs;
    const stored = new Set(refLocations(layout).map((item) => refKey(item.ref)));
    const accepted = new Set();
    const pending = new Map();
    // Accept parents before their children (bounded: one pass per accepted child).
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of liveSessionIds) {
        const key = `session:${id}`;
        const parentId = parents[id];
        if (stored.has(key) || accepted.has(key) || typeof parentId !== 'string' || parentId === id) continue;
        const parentKey = `session:${parentId}`;
        if (!stored.has(parentKey) && !accepted.has(parentKey)) continue;
        accepted.add(key);
        if (!pending.has(parentKey)) pending.set(parentKey, []);
        pending.get(parentKey).push({ kind: 'session', id });
        changed = true;
      }
    }
    if (!pending.size) return (refs) => refs;
    return (refs) => {
      const out = [...refs];
      for (const [parentKey, children] of pending) {
        const block = lineageBlock(layout, { kind: 'session', id: parentKey.slice(8) }, parents);
        let at = -1;
        out.forEach((ref, index) => {
          if (block.has(refKey(ref))) at = index;
        });
        if (at >= 0) out.splice(at + 1, 0, ...children);
      }
      return out;
    };
  }

  /**
   * Everything that changes the grouped rail's STRUCTURE (which rows exist and
   * where, the headers' names, what a collapse hides), as opposed to a row's own
   * status/name/badges. The incremental render path only patches rows in place,
   * so a change here forces a full rebuild.
   *
   * Deliberately NOT the layout version: the server bumps it on every session
   * create/close and order PUT, and a bump that moves nothing visible must not
   * cost every client a full tab-strip rebuild. `layout` is accepted for
   * signature stability only.
   */
  function structureKey(_layout, projection, collapsedGroupIds) {
    if (!projection) return null;
    return JSON.stringify({
      collapsed: stableIds(collapsedGroupIds).sort(),
      // Focus moves no row, but a row's star and its Alt+N badge follow it.
      focus: (projection.focusRefs || []).map(refKey),
      sections: projection.sections.map((section) => [
        section.id,
        section.name,
        section.count,
        section.collapsed === true,
        section.headless === true,
        section.refs.map(refKey),
        (section.hidden || []).map(refKey),
      ]),
    });
  }

  /**
   * Grouped rail markup. `renderRef(ref)` returns one row's HTML ('' to skip it);
   * `escapeHtml` is the caller's escaper. Group names are user content, so they
   * are escaped and marked `data-i18n-skip`.
   *
   * The caller makes the list itself the `tree` and marks rows up as treeitems
   * (app.js `_applyTabTreeSemantics`); this markup supplies the structure:
   *  - a named group's header is a level-1 `treeitem` carrying `aria-expanded`.
   *    Its rows are a sibling `group`, so the header OWNS it via `aria-owns`
   *    (the rows sit below the header visually, not inside it).
   *  - a COLLAPSED group owns nothing: the one row it still shows (the
   *    selection) is a level-1 sibling, never the child of a closed node.
   *  - a group with NO open rows is a leaf: no `aria-expanded`, no owned group,
   *    so it is not announced as an expanded parent of an empty group.
   *  - Ungrouped rows are level-1 items. Their "Ungrouped" heading is a visual
   *    divider only, hidden from assistive tech, and its rows are not a group.
   */
  function renderProjection(projection, renderRef, escapeHtml) {
    const sections = projection && Array.isArray(projection.sections) ? projection.sections : [];
    return sections
      .map((section, index) => {
        const rows = section.refs.map((ref) => renderRef(ref)).join('');
        if (section.id === null && section.headless) {
          return `<section class="tab-layout-group tab-layout-ungrouped tab-layout-ungrouped--headless" role="presentation" data-tab-group-id=""><div class="tab-layout-group-refs" role="presentation">${rows}</div></section>`;
        }
        if (section.id === null) {
          return (
            '<section class="tab-layout-group tab-layout-ungrouped" role="presentation" data-tab-group-id="">' +
            `<div class="tab-layout-group-header tab-layout-ungrouped-header" aria-hidden="true"><span class="tab-layout-group-name">Ungrouped</span><span class="tab-layout-group-count">${section.count}</span></div>` +
            `<div class="tab-layout-group-refs" role="presentation">${rows}</div></section>`
          );
        }
        const id = escapeHtml(section.id);
        const refsId = `tab-layout-group-refs-${index}`;
        const nameId = `tab-layout-group-name-${index}`;
        const leaf = section.count === 0;
        const expanded = !section.collapsed && !leaf;
        const expandedAttr = leaf ? '' : ` aria-expanded="${expanded ? 'true' : 'false'}"`;
        return (
          `<section class="tab-layout-group${section.collapsed ? ' tab-layout-group--collapsed' : ''}" role="presentation" data-tab-group-id="${id}">` +
          `<div class="tab-layout-group-header tab-layout-group-toggle" role="treeitem" tabindex="-1" data-tab-group-header="${id}"${expandedAttr}${expanded ? ` aria-owns="${refsId}"` : ''} onclick="app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)" oncontextmenu="event.preventDefault(); app.openTabGroupMenu(event, this.dataset.tabGroupHeader)">` +
          '<span class="tab-layout-group-chevron" aria-hidden="true"></span>' +
          `<span class="tab-layout-group-name" id="${nameId}" data-i18n-skip>${escapeHtml(section.name)}</span>` +
          `<span class="tab-layout-group-count">${section.count}</span>` +
          // Pointer path to the group menu (right-click on the header works too).
          // Deliberately NOT a button and not focusable: a treeitem holds no
          // interactive children, and the keyboard path is Shift+F10 /
          // ContextMenu on the header itself. aria-hidden keeps the glyph out of
          // the header's accessible name.
          '<span class="tab-layout-group-menu" aria-hidden="true" title="Group actions" ' +
          'onclick="event.stopPropagation(); app.openTabGroupMenu(event, this.closest(\'[data-tab-group-header]\').dataset.tabGroupHeader)">&#x22EF;</span></div>' +
          `<div class="tab-layout-group-refs" id="${refsId}" ${expanded ? `role="group" aria-labelledby="${nameId}"` : 'role="presentation"'}>${rows}</div></section>`
        );
      })
      .join('');
  }

  /**
   * Newest-wins layout loading. A response that was overtaken by a later load is
   * dropped; a failure applies the fallback (the flat rail) and schedules ONE
   * retry, replacing any retry already pending.
   *
   * Retries back off and stop: the delay doubles from `retryDelayMs` up to
   * `maxRetryDelayMs`, and after `maxRetries` consecutive failures nothing more
   * is scheduled (`scheduleRetry(fn, delayMs)`). The next outside load (an SSE
   * reconnect re-runs init, a `tab:layoutChanged` re-reads) tries again, and
   * any success resets the count.
   */
  function createLoadCoordinator(options) {
    const baseDelay = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 5000;
    const maxDelay = Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 60000;
    const maxRetries = Number.isSafeInteger(options.maxRetries) ? options.maxRetries : 4;
    let generation = 0;
    let disposed = false;
    let retryHandle = null;
    let failures = 0;
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
        failures = 0;
        options.applyLayout(layout);
        return true;
      } catch (_error) {
        if (disposed || requestGeneration !== generation) return false;
        failures++;
        options.applyFallback();
        if (failures <= maxRetries) {
          const delay = Math.min(maxDelay, baseDelay * 2 ** (failures - 1));
          retryHandle = options.scheduleRetry(() => load(), delay);
        }
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

  // ─── Editing ────────────────────────────────────────────────────────────
  //
  // The browser edits through NAMED operations, not by diffing arrays: a write
  // that loses a version race (409) is rebased by replaying the same operations
  // on the layout the server returned, so a concurrent edit elsewhere survives.
  // The server stays the authority: it re-validates and normalizes every PUT.

  function editError(message) {
    throw new Error(`Tab layout edit failed: ${message}`);
  }

  const clampIndex = (value, length) => (Number.isInteger(value) ? Math.max(0, Math.min(value, length)) : length);

  function groupName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) editError(`group name must be 1-${MAX_NAME_LENGTH} characters`);
    return name;
  }

  function refLocations(layout) {
    return [
      ...layout.groups.flatMap((group) => group.refs.map((ref) => ({ groupId: group.id, ref }))),
      ...layout.ungrouped.map((ref) => ({ groupId: null, ref })),
    ];
  }

  /** The stored (mutable) ref in a layout copy; throws when it is not stored. */
  function storedRef(layout, target) {
    const found = refLocations(layout).find((item) => refKey(item.ref) === refKey(target));
    if (!found) editError('unknown row');
    return found.ref;
  }

  function containerRefs(layout, groupId) {
    if (groupId === null) return layout.ungrouped;
    const group = layout.groups.find((candidate) => candidate.id === groupId);
    if (!group) editError('unknown group');
    return group.refs;
  }

  /**
   * The rows that move together with `ref`: the session plus every descendant
   * that still follows its parent (non-manual, parent stored). Mirrors the
   * server's moveRef block so the optimistic rail matches what it will store.
   * `parents` maps a session id to its parent session id.
   */
  function lineageBlock(layout, ref, parents) {
    const stored = new Map(refLocations(layout).map((item) => [refKey(item.ref), item.ref]));
    const children = new Map();
    for (const [childId, parentId] of Object.entries(parents || {})) {
      const child = stored.get(`session:${childId}`);
      if (!child || child.placement === 'manual' || !stored.has(`session:${parentId}`)) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(childId);
    }
    const keys = new Set();
    const visit = (key) => {
      if (keys.has(key)) return;
      keys.add(key);
      if (key.startsWith('session:')) for (const id of children.get(key.slice(8)) || []) visit(`session:${id}`);
    };
    visit(refKey(ref));
    return keys;
  }

  /**
   * How a child session is placed, for the row menu. null for a session with no
   * parent (or not stored). Otherwise `{ state, parentId, canFollow }`:
   *  - inherited: it follows its parent (moves with it).
   *  - manual: placed by hand; "Follow parent again" puts it back.
   *  - dangling: its parent is not in this layout (closed, or another owner's),
   *    so it stands on its own; nothing re-adopts it automatically.
   *  - cycle: the parent chain loops back to it; it stands on its own.
   */
  function placementState(layoutInput, ref, parents) {
    const layout = normalizeLayout(layoutInput);
    if (!validRef(ref) || ref.kind !== 'session') return null;
    const parentId = parents?.[ref.id];
    if (typeof parentId !== 'string' || !parentId || parentId === ref.id) return null;
    const stored = new Map(refLocations(layout).map((item) => [refKey(item.ref), item.ref]));
    const own = stored.get(refKey(ref));
    if (!own) return null;
    if (!stored.has(`session:${parentId}`)) return { state: 'dangling', parentId, canFollow: false };
    // Walk up the stored ancestors; meeting this session again is a loop.
    const seen = new Set([ref.id]);
    for (let id = parentId; id && stored.has(`session:${id}`); id = parents[id]) {
      if (seen.has(id)) return { state: 'cycle', parentId, canFollow: false };
      seen.add(id);
    }
    return own.placement === 'manual'
      ? { state: 'manual', parentId, canFollow: true }
      : { state: 'inherited', parentId, canFollow: false };
  }

  /**
   * Where a moved row lands, as the server's `index` (counted AFTER the moved
   * block is taken out): before or after `anchor` in that container, or at its
   * end when there is no anchor.
   */
  function moveDestination(layoutInput, ref, groupId, anchor, placement, parents) {
    const layout = normalizeLayout(layoutInput);
    const block = lineageBlock(layout, ref, parents);
    const remaining = containerRefs(layout, groupId).filter((candidate) => !block.has(refKey(candidate)));
    // No anchor means "at the end", and an operation with no index keeps
    // meaning that when it is replayed onto a layout that has changed since.
    if (!anchor) return { groupId };
    const at = remaining.findIndex((candidate) => refKey(candidate) === refKey(anchor));
    if (at < 0) return { groupId };
    return { groupId, index: placement === 'after' ? at + 1 : at };
  }

  /**
   * Map a finished drag to ONE operation (or null for a drop that changes
   * nothing). Pure, so the drop -> PUT mapping is testable without a pointer.
   *
   * source: { type: 'ref', ref, fromFocus? } | { type: 'group', groupId }
   *   (`fromFocus`: the drag started on a Focus SHORTCUT, not on the row)
   * target: { type: 'ref', ref, groupId, placement: 'before' | 'after' }
   *       | { type: 'group', groupId }   (a named group's header or empty body)
   *       | { type: 'ungrouped' }
   *   (groupId FOCUS_SECTION_ID: the Focus list, or one of its shortcuts)
   *
   * A group dropped on another group (or any row in it) takes that group's slot;
   * dropped on the Ungrouped section it goes last. A row dropped on a row lands
   * before/after it, on a header it is appended to that group.
   *
   * Focus is a list of shortcuts (COD-525), so a drag never moves a row out of
   * its group on Focus's account: a row dropped on Focus joins it and stays
   * put; a row moved between groups keeps its Focus pin; a shortcut dropped
   * inside Focus reorders Focus, and dropped anywhere else does nothing.
   */
  function dropOperation(layoutInput, source, target, parents) {
    const layout = normalizeLayout(layoutInput);
    if (!source || !target) return null;
    const intoFocus = target.groupId === FOCUS_SECTION_ID;
    if (source.type === 'group') {
      if (source.groupId === FOCUS_SECTION_ID || intoFocus) return null;
      const from = layout.groups.findIndex((group) => group.id === source.groupId);
      if (from < 0) return null;
      const targetId = target.type === 'ungrouped' ? null : (target.groupId ?? null);
      const to = targetId === null ? layout.groups.length - 1 : layout.groups.findIndex((g) => g.id === targetId);
      if (to < 0 || to === from) return null;
      return { type: 'reorderGroup', groupId: source.groupId, index: to };
    }
    if (source.type !== 'ref' || !validRef(source.ref)) return null;
    const location = refLocations(layout).find((item) => refKey(item.ref) === refKey(source.ref));
    if (!location) return null;
    const ref = bareRef(source.ref);
    const focused = location.ref.focus === true;
    if (intoFocus) {
      // Onto the Focus list: join Focus (at its end). Onto a shortcut: join
      // if needed, then take that shortcut's slot in the Focus order. The
      // row itself stays where it is stored.
      const operations = focused ? [] : [{ type: 'setFocus', ref, focused: true }];
      if (target.type === 'ref' && validRef(target.ref) && refKey(target.ref) !== refKey(ref)) {
        const others = orderedFocusRefs(layout).filter((candidate) => refKey(candidate) !== refKey(ref));
        const at = others.findIndex((candidate) => refKey(candidate) === refKey(target.ref));
        if (at >= 0) operations.push({ type: 'moveFocus', ref, index: target.placement === 'after' ? at + 1 : at });
      }
      if (!operations.length) return null;
      const result = operations.reduce((current, operation) => applyOperation(current, operation), layout);
      if (contentKey(result) === contentKey(layout)) return null;
      return operations.length === 1 ? operations[0] : operations;
    }
    // A shortcut dropped outside Focus does nothing (upstream's rule): the
    // shortcut stands for the row, it is not the row, so the row never moves,
    // and leaving Focus stays a deliberate "Remove from Focus".
    if (source.fromFocus === true) return null;
    let groupId;
    let anchor = null;
    let placement = 'before';
    if (target.type === 'ref' && validRef(target.ref)) {
      // Onto itself or onto a row that moves with it: nowhere to go.
      if (lineageBlock(layout, source.ref, parents).has(refKey(target.ref))) return null;
      groupId = target.groupId ?? null;
      anchor = target.ref;
      placement = target.placement === 'after' ? 'after' : 'before';
    } else if (target.type === 'group') {
      groupId = target.groupId ?? null;
      if (groupId === location.groupId) return null;
    } else if (target.type === 'ungrouped') {
      groupId = null;
      if (location.groupId === null) return null;
    } else return null;
    if (groupId !== null && !layout.groups.some((group) => group.id === groupId)) return null;
    const destination = moveDestination(layout, source.ref, groupId, anchor, placement, parents);
    const operation = {
      type: 'moveRef',
      ref: { kind: source.ref.kind, id: source.ref.id },
      groupId: destination.groupId,
      ...(destination.index === undefined ? {} : { index: destination.index }),
      parents: parents || {},
    };
    return contentKey(applyOperation(layout, operation)) === contentKey(layout) ? null : operation;
  }

  /**
   * Apply one operation to a copy of the layout. Throws when the operation no
   * longer makes sense (an unknown group or row); a rebase drops that one
   * operation and keeps the rest. Replays are idempotent where it matters for
   * recovery: creating a group that already exists is a no-op.
   */
  function applyOperation(layoutInput, operation) {
    const layout = normalizeLayout(layoutInput);
    const op = operation || {};
    const groupIndex = layout.groups.findIndex((group) => group.id === op.groupId);
    switch (op.type) {
      case 'createGroup': {
        if (typeof op.id !== 'string' || !op.id) editError('invalid group id');
        const name = groupName(op.name);
        if (layout.groups.some((group) => group.id === op.id)) return layout;
        if (layout.groups.length >= MAX_GROUPS) editError('group limit reached');
        layout.groups.splice(clampIndex(op.index, layout.groups.length), 0, { id: op.id, name, refs: [] });
        return layout;
      }
      case 'renameGroup':
        if (groupIndex < 0) editError('unknown group');
        layout.groups[groupIndex].name = groupName(op.name);
        return layout;
      case 'deleteGroup': {
        // Already gone (deleted elsewhere): nothing left to do.
        if (groupIndex < 0) return layout;
        const [removed] = layout.groups.splice(groupIndex, 1);
        layout.ungrouped.push(...removed.refs);
        return layout;
      }
      case 'reorderGroup': {
        if (groupIndex < 0) editError('unknown group');
        const [moved] = layout.groups.splice(groupIndex, 1);
        layout.groups.splice(clampIndex(op.index, layout.groups.length), 0, moved);
        return layout;
      }
      case 'moveRef': {
        if (!validRef(op.ref)) editError('invalid row');
        const targetKey = refKey(op.ref);
        if (!refLocations(layout).some((item) => refKey(item.ref) === targetKey)) editError('unknown row');
        const destinationId = op.groupId ?? null;
        containerRefs(layout, destinationId);
        const keys = lineageBlock(layout, op.ref, op.parents);
        const block = refLocations(layout)
          .filter((item) => keys.has(refKey(item.ref)))
          .map((item) => copyRef(item.ref));
        // A hand-moved child stops following its parent (server moveRef does the same).
        const head = block.find((item) => refKey(item) === targetKey);
        if (op.ref.kind === 'session' && op.parents?.[op.ref.id]) head.placement = 'manual';
        block.sort((a, b) => (a === head ? -1 : b === head ? 1 : 0));
        for (const group of layout.groups) group.refs = group.refs.filter((ref) => !keys.has(refKey(ref)));
        layout.ungrouped = layout.ungrouped.filter((ref) => !keys.has(refKey(ref)));
        const destination = containerRefs(layout, destinationId);
        destination.splice(clampIndex(op.index, destination.length), 0, ...block);
        return layout;
      }
      case 'setFocus': {
        if (!validRef(op.ref) || typeof op.focused !== 'boolean') editError('invalid Focus state');
        const stored = storedRef(layout, op.ref);
        if (op.focused) stored.focus = true;
        else delete stored.focus;
        // A ref leaving Focus leaves the explicit order with it; one entering
        // is unlisted and therefore sorts after the ordered entries.
        return prunedFocusOrder(layout);
      }
      case 'moveFocus': {
        if (!validRef(op.ref)) editError('invalid row');
        storedRef(layout, op.ref);
        const ordered = orderedFocusRefs(layout);
        const from = ordered.findIndex((ref) => refKey(ref) === refKey(op.ref));
        if (from < 0) editError('row is not in Focus');
        const [moved] = ordered.splice(from, 1);
        ordered.splice(clampIndex(op.index, ordered.length), 0, moved);
        layout.focusOrder = ordered;
        return layout;
      }
      case 'setManualPlacement': {
        if (!validRef(op.ref) || op.manual !== true) editError('invalid placement');
        storedRef(layout, op.ref).placement = 'manual';
        return layout;
      }
      case 'followParent': {
        // The server re-files the session under its parent on this write; the
        // optimistic copy lands it right after the parent so the rail does not
        // jump twice.
        if (!validRef(op.ref) || op.ref.kind !== 'session') editError('only a session can follow a parent');
        const parentId = op.parents?.[op.ref.id];
        if (!parentId) editError('session has no parent');
        const stored = storedRef(layout, op.ref);
        storedRef(layout, { kind: 'session', id: parentId });
        delete stored.placement;
        const keys = lineageBlock(layout, op.ref, op.parents);
        const block = refLocations(layout)
          .filter((item) => keys.has(refKey(item.ref)))
          .map((item) => item.ref);
        if (keys.has(`session:${parentId}`)) return layout;
        for (const group of layout.groups) group.refs = group.refs.filter((ref) => !keys.has(refKey(ref)));
        layout.ungrouped = layout.ungrouped.filter((ref) => !keys.has(refKey(ref)));
        const parentAt = refLocations(layout).find((item) => refKey(item.ref) === `session:${parentId}`);
        const destination = containerRefs(layout, parentAt.groupId);
        destination.splice(destination.findIndex((ref) => refKey(ref) === `session:${parentId}`) + 1, 0, ...block);
        return layout;
      }
      default:
        return editError(`unknown operation ${op.type}`);
    }
  }

  /** Layout content without version metadata: equal keys mean "nothing to save". */
  function contentKey(layoutInput) {
    const layout = normalizeLayout(layoutInput);
    return JSON.stringify([layout.groups, layout.ungrouped, orderedFocusRefs(layout)]);
  }

  /**
   * Operations as `PUT /api/tab-layout { operations }` accepts them, replayed
   * from `base`. The server requires an explicit index on every moveRef, while
   * the browser's "at the end" move carries none (so a rebase keeps meaning
   * the end): fill it in with the destination's length at that step, counted
   * after the moving block is taken out, as the server counts. `parents` is a
   * browser-side hint and stays behind; the server uses its own lineage.
   * Operations that no longer apply are dropped, as replayOperations() does.
   */
  function wireOperations(base, operations) {
    let layout = normalizeLayout(base);
    const result = [];
    for (const operation of operations) {
      let wire = operation;
      if (operation?.type === 'moveRef' || operation?.type === 'followParent') {
        const { parents: _parents, ...rest } = operation;
        wire = rest;
      }
      try {
        if (operation?.type === 'moveRef' && !Number.isInteger(operation.index)) {
          const block = lineageBlock(layout, operation.ref, operation.parents);
          const remaining = containerRefs(layout, operation.groupId ?? null).filter((ref) => !block.has(refKey(ref)));
          wire = { ...wire, index: remaining.length };
        }
        layout = applyOperation(layout, operation);
        result.push(wire);
      } catch (_error) {
        // Dropped: the same edit replayOperations() drops.
      }
    }
    return result;
  }

  /** Replay operations, dropping (and counting) the ones that no longer apply. */
  function replayOperations(base, operations) {
    let layout = normalizeLayout(base);
    const kept = [];
    let dropped = 0;
    for (const operation of operations) {
      try {
        layout = applyOperation(layout, operation);
        kept.push(operation);
      } catch (_error) {
        dropped++;
      }
    }
    return { layout, kept, dropped };
  }

  /**
   * Serialized, optimistic writer for `PUT /api/tab-layout`.
   *
   *  - enqueue() applies an operation at once (the rail repaints optimistically)
   *    and schedules a flush; operations enqueued in the same turn share a PUT.
   *  - Exactly ONE write is in flight. Operations enqueued meanwhile wait and are
   *    sent on top of the version that write returns.
   *  - A 409 carries the server's current layout: the in-flight operations are
   *    replayed onto it and re-sent with its version (bounded attempts). A 400
   *    (a row vanished between read and write) re-reads and rebases the same way.
   *  - Anything else, or attempts exhausted, drops the batch and reports it; the
   *    caller re-reads so the rail shows the server's truth.
   *
   * options: { initialLayout, put({ baseVersion, layout, operations }) -> { ok, status,
   *   layout }, fetchLayout?(), applyLayout(layout, meta), reportError?(message),
   *   onSettled?(), onFailure?(), schedule?(fn), cancel?(handle), maxAttempts? }
   */
  function createEditCoordinator(options) {
    let authoritative = normalizeLayout(options.initialLayout);
    let optimistic = authoritative;
    let pending = [];
    let inFlight = [];
    let writing = false;
    let timer = null;
    let disposed = false;
    const schedule = options.schedule || ((fn) => setTimeout(fn, 0));
    const cancel = options.cancel || ((handle) => clearTimeout(handle));
    const maxAttempts = options.maxAttempts || 3;
    const report = (message) => options.reportError?.(message);
    const publish = (meta) => options.applyLayout(normalizeLayout(optimistic), meta);
    const queue = () => {
      if (timer === null) timer = schedule(flush);
    };

    async function flush() {
      timer = null;
      if (disposed || writing || pending.length === 0) return;
      writing = true;
      inFlight = pending;
      pending = [];
      let failed = false;
      let reportedDrop = false;
      let rereadFor400 = false;
      try {
        for (let attempt = 0; attempt < maxAttempts && inFlight.length; attempt++) {
          const desired = replayOperations(authoritative, inFlight);
          inFlight = desired.kept;
          if (desired.dropped && !reportedDrop) {
            reportedDrop = true;
            report('Tab groups changed elsewhere; part of your edit no longer applies.');
          }
          // Nothing left to change (dropped, or already true on the server).
          if (!inFlight.length || contentKey(desired.layout) === contentKey(authoritative)) {
            inFlight = [];
            break;
          }
          const response = await options.put({
            baseVersion: authoritative.version,
            layout: desired.layout,
            operations: wireOperations(authoritative, inFlight),
          });
          if (disposed) return;
          if (response?.ok && response.layout) {
            authoritative = normalizeLayout(response.layout);
            inFlight = [];
          } else if (response?.status === 409 && response.layout) {
            authoritative = normalizeLayout(response.layout);
          } else if (response?.status === 400 && options.fetchLayout && !rereadFor400) {
            // Maybe our base was stale in a way the server reports as invalid:
            // re-read once. A 400 that survives that is a refusal, not a race.
            rereadFor400 = true;
            authoritative = normalizeLayout(await options.fetchLayout());
            if (disposed) return;
          } else {
            throw new Error('Tab layout save failed');
          }
        }
        if (inFlight.length) {
          failed = true;
          report('Tab groups kept changing elsewhere; your edit was not saved.');
        }
      } catch (_error) {
        failed = true;
        report('Could not save tab groups.');
      } finally {
        inFlight = [];
        writing = false;
        if (!disposed) {
          const rebased = replayOperations(authoritative, pending);
          // Edits made while the write was in flight are rebased here, so one the
          // conflict made inapplicable is dropped here too, and says so (once).
          if (rebased.dropped && !failed && !reportedDrop) {
            report('Tab groups changed elsewhere; part of your edit no longer applies.');
          }
          pending = rebased.kept;
          optimistic = rebased.layout;
          publish({ authoritative: true });
          if (failed) options.onFailure?.();
          if (pending.length) queue();
          else options.onSettled?.();
        }
      }
    }

    return {
      /** Apply now, save soon. Throws (and changes nothing) for an invalid edit. */
      enqueue(operation) {
        optimistic = applyOperation(optimistic, operation);
        pending.push(operation);
        publish({ optimistic: true });
        queue();
        return normalizeLayout(optimistic);
      },
      /**
       * Re-apply operations recovered after a reload. Returns false (and queues
       * nothing) when the layout already reflects them, e.g. the keepalive save
       * landed before the page went away.
       */
      restore(operations) {
        const replayed = replayOperations(optimistic, Array.isArray(operations) ? operations : []);
        if (!replayed.kept.length || contentKey(replayed.layout) === contentKey(optimistic)) return false;
        optimistic = replayed.layout;
        pending.push(...replayed.kept);
        publish({ optimistic: true });
        queue();
        return true;
      },
      /**
       * Adopt a layout read from the server (SSE reload). Pending operations are
       * rebased onto it. Refused while a write is in flight (its result decides)
       * and for a layout older than the one already held.
       */
      adoptExternal(layout) {
        if (disposed || writing) return false;
        const next = normalizeLayout(layout);
        if (next.version < authoritative.version) return false;
        authoritative = next;
        const rebased = replayOperations(next, pending);
        if (rebased.dropped) report('Tab groups changed elsewhere; part of your edit no longer applies.');
        pending = rebased.kept;
        optimistic = rebased.layout;
        publish({ authoritative: true, external: true });
        return true;
      },
      flush,
      isWriting: () => writing,
      hasPending: () => writing || pending.length > 0,
      /** Every operation not yet confirmed by the server, oldest first. */
      pendingOperations: () => JSON.parse(JSON.stringify([...inFlight, ...pending])),
      /** The same, in the form the server's semantic PUT accepts (wireOperations). */
      pendingWireOperations: () => wireOperations(authoritative, [...inFlight, ...pending]),
      baseVersion: () => authoritative.version,
      getLayout: () => normalizeLayout(optimistic),
      dispose() {
        disposed = true;
        if (timer !== null) cancel(timer);
        timer = null;
        pending = [];
      },
    };
  }

  global.CodemanTabLayout = {
    normalizeLayout,
    hasGroups,
    project,
    hiddenGroupAlerts,
    structureKey,
    renderProjection,
    applyOperation,
    moveDestination,
    movingRefKeys: (layout, ref, parents) => [...lineageBlock(normalizeLayout(layout), ref, parents)],
    placementState,
    dropOperation,
    contentKey,
    createEditCoordinator,
    wireOperations,
    createLoadCoordinator,
    loadCollapsedGroupIds,
    saveCollapsedGroupIds,
    focusRefs,
    loadFocusCollapsed,
    saveFocusCollapsed,
    orderedFocusRefs,
    describePlacements,
    altRefs,
    filterSessionProjection,
    FOCUS_SECTION_ID,
    MAX_GROUPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
