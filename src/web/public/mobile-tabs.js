/**
 * @fileoverview Mobile Tab Sheet — bottom sheet for 10+ tabs on phones.
 * Shows a pill "12 tabs ▼" in header when count>8 on <430px, opens 70vh sheet with search + filters.
 * Reuses existing tabAlert/pendingHooks styling. Loaded after app.js.
 * @loadorder after app.js
 */

const MOBILE_COLLAPSED_STORAGE_KEY = 'codeman:mobile-tab-groups-collapsed';
const MOBILE_FOCUS_COLLAPSED_STORAGE_KEY = 'codeman:mobile-focus-group-collapsed';

function readMobileCollapsedSet(storage = window.localStorage) {
  try {
    const raw = storage.getItem(MOBILE_COLLAPSED_STORAGE_KEY);
    if (raw === null) return { ids: [], ok: true };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Invalid mobile collapsed tab groups');
    return {
      ids: [...new Set(parsed.filter((id) => typeof id === 'string' && id.length > 0))],
      ok: true,
    };
  } catch (_error) {
    return { ids: [], ok: false };
  }
}

function readMobileFocusCollapsed(storage = window.localStorage) {
  try {
    const raw = storage.getItem(MOBILE_FOCUS_COLLAPSED_STORAGE_KEY);
    if (raw === null || raw === 'false') return { collapsed: false, ok: true };
    if (raw === 'true') return { collapsed: true, ok: true };
    throw new Error('Invalid mobile Focus collapse state');
  } catch (_error) {
    return { collapsed: false, ok: false };
  }
}

const MobileTabSheet = {
  _filter: 'all',
  _q: '',
  _mobileCollapsedGroupIds() {
    // Corrupt/unavailable storage reads as "nothing collapsed" (all expanded); corruption cleanup is deferred to toggle/projection tasks.
    return readMobileCollapsedSet().ids;
  },
  _mobileFocusCollapsed() {
    // Corrupt/unavailable storage reads as "nothing collapsed" (all expanded); corruption cleanup is deferred to toggle/projection tasks.
    return readMobileFocusCollapsed().collapsed;
  },
  _saveMobileCollapsedGroupIds(ids) {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    try {
      window.localStorage.setItem(MOBILE_COLLAPSED_STORAGE_KEY, JSON.stringify(unique));
    } catch (_error) {
      this._mobileCollapseStorageFailed = true;
    }
    return unique;
  },
  toggleMobileGroupCollapsed(groupId, forceCollapsed) {
    const next = new Set(this._mobileCollapsedGroupIds());
    const shouldCollapse = forceCollapsed === undefined ? !next.has(groupId) : forceCollapsed === true;
    if (shouldCollapse) next.add(groupId);
    else next.delete(groupId);
    this._saveMobileCollapsedGroupIds([...next]);
    this.render();
    return this._mobileCollapsedGroupIds().includes(groupId) === shouldCollapse;
  },
  toggleMobileFocusCollapsed(forceCollapsed) {
    const shouldCollapse = forceCollapsed === undefined ? !this._mobileFocusCollapsed() : forceCollapsed === true;
    try {
      window.localStorage.setItem(MOBILE_FOCUS_COLLAPSED_STORAGE_KEY, shouldCollapse ? 'true' : 'false');
    } catch (_error) {
      this._mobileCollapseStorageFailed = true;
    }
    this.render();
    return this._mobileFocusCollapsed() === shouldCollapse;
  },
  _mobileProjection() {
    const app = window.app;
    if (!app || typeof window.CodemanTabLayout?.project !== 'function') return null;
    const sessions = app.sessions;
    const liveSessionIds = sessions && typeof sessions.keys === 'function' ? [...sessions.keys()] : [];
    try {
      const projection = window.CodemanTabLayout.project(app.tabLayout || { version: 0, groups: [], ungrouped: [] }, {
        liveSessionIds,
        legacySessionOrder: Array.isArray(app.sessionOrder) ? app.sessionOrder : liveSessionIds,
        openWebviewIds: [],
        // The sheet owns its collapse rendering. Passing the mobile state to
        // the shared projection removes hidden refs, which also removes the
        // section header when no member is selected.
        collapsedGroupIds: [],
        activeSessionId: app.activeSessionId,
        activeWebviewId: null,
        orientation: 'vertical',
        focusCollapsed: false,
      });
      // While filtering, narrow the projection to matching sessions — same
      // shape as the desktop rail's search path (filterSessionProjection).
      if (
        (this._filter !== 'all' || (this._q || '').length > 0) &&
        typeof window.CodemanTabLayout?.filterSessionProjection === 'function'
      ) {
        const matchingSessionIds = liveSessionIds.filter((id) => {
          let session = null;
          try {
            session = sessions?.get?.(id) ?? null;
          } catch {
            return false;
          }
          if (!session) return false;
          const { status, alert } = this._classifySession(id, session);
          return this._matchesMobileFilters({ id, session, status, alert });
        });
        return window.CodemanTabLayout.filterSessionProjection(projection, matchingSessionIds);
      }
      return projection;
    } catch (_error) {
      return null;
    }
  },
  _mobileFallbackSections() {
    const app = window.app;
    const order = Array.isArray(app?.sessionOrder) ? app.sessionOrder : [];
    const sessions = app?.sessions;
    const refs = order
      .filter((id) => {
        try {
          return sessions?.has?.(id) === true;
        } catch {
          return false;
        }
      })
      .map((id) => ({ kind: 'session', id }));
    return [
      {
        id: null,
        name: '',
        refs,
        refIndices: refs.map((_, index) => index),
        count: refs.length,
        collapsed: false,
      },
    ];
  },
  _classifySession(id, session) {
    const tabAlerts = window.app.tabAlerts;
    const pendingHooks = window.app.pendingHooks;
    const alert = tabAlerts?.get(id);
    const hooks = pendingHooks?.get(id);
    if (alert === 'action' || hooks?.has('permission_prompt') || hooks?.has('elicitation_dialog')) {
      return { status: 'action', alert };
    }
    if (alert === 'idle' || hooks?.has('idle_prompt')) return { status: 'idle', alert };
    if (session.status === 'busy' || session.isWorking) return { status: 'busy', alert };
    return { status: 'idle', alert };
  },
  _matchesMobileFilters(item) {
    if (this._filter === 'needs' && item.status !== 'action') return false;
    if (this._filter === 'working' && item.status !== 'busy') return false;
    if (this._filter === 'idle' && item.status !== 'idle') return false;
    const q = (this._q || '').toLowerCase();
    if (!q) return true;
    return (
      item.session.name?.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      (item.session.mode || '').toLowerCase().includes(q)
    );
  },
  _mobileSheetRow(item, activeId) {
    const isActive = item.id === activeId;
    const dotClass =
      item.status === 'busy'
        ? 'busy'
        : item.status === 'action'
          ? 'action'
          : item.status === 'idle' && item.alert === 'idle'
            ? 'idle'
            : '';
    const mode = item.session.mode || 'claude';
    const name = item.session.name || item.id.slice(0, 8);
    const branch = name.includes('-') ? name.split('-').slice(1).join('-') : '';
    return `<div class="sheet-row ${isActive ? 'active' : ''}" data-session-id="${item.id}" onclick="MobileTabSheet.activate('${item.id}')">
        <span class="dot ${dotClass}"></span>
        <div class="row-info"><div class="row-name">${name}</div><div class="row-meta">${branch || mode} · ${mode}</div></div>
        <span class="badge ${mode}">${mode.slice(0, 2)}</span>
        ${item.status === 'action' ? '<span class="row-needs">● needs</span>' : ''}
        ${item.status === 'busy' ? '<span class="row-working">● working</span>' : ''}
        <button class="row-close" onclick="event.stopPropagation();MobileTabSheet.closeTab('${item.id}')" aria-label="Close">×</button>
      </div>`;
  },
  _mobileEscapeAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  },
  init() {
    // Always create elements — _isEnabled gates visibility, not existence (debug on desktop + ensures iPhone race never hides pill)
    this._createElements();
    this._bindEvents();
    this._patchApp();
    // Robustness: if header is re-rendered and pill removed, re-create immediately
    try {
      const header = document.querySelector('.header');
      if (header && window.MutationObserver) {
        const obs = new MutationObserver(() => {
          if (!document.getElementById('mobileTabPill')) {
            console.log('[MobileTabSheet] pill missing — recreating');
            this._createElements();
            this.updatePill();
          }
        });
        obs.observe(header, { childList: true, subtree: false });
        this._headerObserver = obs;
      }
    } catch {}
    // Also ensure pill stays visible even if something else hides it — force every 800ms
    setInterval(() => {
      const p = document.getElementById('mobileTabPill');
      if (p && this._isEnabled() && getComputedStyle(p).display === 'none') {
        console.log('[MobileTabSheet] pill was hidden — forcing visible');
        p.style.setProperty('display', 'inline-flex', 'important');
      }
    }, 800);
    console.log('[MobileTabSheet] init', { isMobile: this._isEnabled(), width: window.innerWidth });
  },
  _isEnabled() {
    return window.innerWidth < 600;
  },
  _shouldShowPill() {
    try {
      const n = window.app && window.app.sessionOrder ? window.app.sessionOrder.length : 0;
      return this._isEnabled() && n > 8;
    } catch {
      return false;
    }
  },
  _createElements() {
    // Pill in header next to logo
    const brand = document.querySelector('.header-brand');
    if (brand && !document.getElementById('mobileTabPill')) {
      const pill = document.createElement('button');
      pill.id = 'mobileTabPill';
      pill.className = 'mobile-tab-pill';
      pill.setAttribute('aria-label', 'Open tab list');
      pill.setAttribute('aria-expanded', 'false');
      pill.setAttribute('aria-controls', 'mobileTabSheet');
      pill.innerHTML =
        '<span class="pill-mini"></span><span class="pill-count">0</span><span class="pill-chev">▼</span>';
      brand.insertAdjacentElement('afterend', pill);
    }
    this._bindPill();
    // Scrim + sheet at body level so fixed positioning is viewport-relative
    if (!document.getElementById('mobileTabSheet')) {
      const scrim = document.createElement('div');
      scrim.id = 'mobileTabScrim';
      scrim.className = 'mobile-tab-scrim';
      scrim.onclick = () => this.toggle(false);
      document.body.appendChild(scrim);

      const sheet = document.createElement('div');
      sheet.id = 'mobileTabSheet';
      sheet.className = 'mobile-tab-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'Switch tabs');
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <div class="sheet-search"><input id="mobileTabSearch" placeholder="Search tabs…  (w3, auth, api)" autocomplete="off" spellcheck="false"><span class="sheet-count"></span></div>
        <div class="sheet-filters">
          <button class="sheet-chip active" data-filter="all">All</button>
          <button class="sheet-chip" data-filter="needs">Needs input ★</button>
          <button class="sheet-chip" data-filter="working">Working ●</button>
          <button class="sheet-chip" data-filter="idle">Idle</button>
        </div>
        <div class="sheet-list" id="mobileTabList"></div>
        <div class="sheet-footer"><span>Swipe up — tap row to switch</span><span class="sheet-footer-count"></span></div>
      `;
      document.body.appendChild(sheet);
    }
  },
  _bindPill() {
    const pill = document.getElementById('mobileTabPill');
    if (!pill || pill.dataset.mobileTabSheetBound === 'true') return;
    pill.dataset.mobileTabSheetBound = 'true';
    pill.addEventListener('click', () => this.toggle());
  },
  _bindEvents() {
    const input = document.getElementById('mobileTabSearch');
    if (input)
      input.addEventListener('input', (e) => {
        this._q = (e.target.value || '').toLowerCase().trim();
        this.render();
      });
    const chips = document.querySelectorAll('#mobileTabSheet .sheet-chip');
    chips.forEach((c) =>
      c.addEventListener('click', () => {
        this._filter = c.dataset.filter;
        chips.forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        this.render();
      })
    );
    // Swipe down from the top handle to close. Content gestures belong to their
    // own controls, especially the vertically scrollable session list.
    const handle = document.querySelector('#mobileTabSheet .sheet-handle');
    let startY = null;
    handle?.addEventListener(
      'touchstart',
      (e) => {
        startY = e.touches[0]?.clientY ?? null;
      },
      { passive: true }
    );
    handle?.addEventListener(
      'touchmove',
      (e) => {
        const currentY = e.touches[0]?.clientY;
        if (startY !== null && currentY !== undefined && currentY - startY > 50) {
          startY = null;
          this.toggle(false);
        }
      },
      { passive: true }
    );
    const resetHandleSwipe = () => {
      startY = null;
    };
    handle?.addEventListener('touchend', resetHandleSwipe, { passive: true });
    handle?.addEventListener('touchcancel', resetHandleSwipe, { passive: true });
    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggle(false);
    });
  },
  _patchApp() {
    const app = window.app;
    if (!app) {
      setTimeout(() => this._patchApp(), 300);
      return;
    }
    const orig = app.renderSessionTabs?.bind(app);
    const origImmediate = app._renderSessionTabsImmediate?.bind(app);
    const self = this;
    // Debounced wrapper calls render after tab structure changes
    if (orig) {
      app.renderSessionTabs = function (...a) {
        const r = orig(...a);
        self.updatePill();
        self.render();
        return r;
      };
    }
    if (origImmediate) {
      app._renderSessionTabsImmediate = function (...a) {
        const r = origImmediate(...a);
        self.updatePill();
        self.render();
        return r;
      };
    }
    // Update on session changes via mutation observer fallback
    setInterval(() => {
      self.updatePill();
    }, 1500);
    this.updatePill();
    this.render();
  },
  updatePill() {
    let pill = document.getElementById('mobileTabPill');
    if (!pill) {
      // Pill was removed (header re-render) — recreate
      this._createElements();
      pill = document.getElementById('mobileTabPill');
      if (!pill) return;
    }
    const order = window.app?.sessionOrder || [];
    let n = order.length;
    try {
      const sessions = window.app?.sessions;
      if (sessions && typeof sessions.has === 'function') {
        const liveCount = order.filter((id) => {
          try {
            return sessions.has(id);
          } catch {
            return false;
          }
        }).length;
        // Use the live-session count when the sessions map knows about ordered
        // ids (or is non-empty); otherwise fall back to raw order length so
        // fixtures that only set sessionOrder still show the pill.
        if (liveCount > 0 || (typeof sessions.size === 'number' && sessions.size > 0)) n = liveCount;
      }
    } catch {
      n = order.length;
    }
    const isMobile = this._isEnabled();
    const showPill = isMobile && n >= 1;
    const hideStrip = isMobile;
    // Debug: log every 5s if pill would hide
    if (!showPill)
      console.log('[MobileTabSheet] pill hidden', { n, isMobile: this._isEnabled(), w: window.innerWidth });
    try {
      pill.style.setProperty('display', showPill ? 'inline-flex' : 'none', 'important');
      pill.style.setProperty('visibility', showPill ? 'visible' : 'hidden', 'important');
      pill.style.setProperty('opacity', showPill ? '1' : '0', 'important');
    } catch {
      pill.style.display = showPill ? 'inline-flex' : 'none';
    }
    const tabsHost = document.getElementById('sessionTabsHost');
    if (tabsHost) {
      try {
        tabsHost.style.setProperty('display', hideStrip ? 'none' : '', 'important');
      } catch {
        tabsHost.style.display = hideStrip ? 'none' : '';
      }
    }
    const countEl = pill.querySelector('.pill-count');
    if (countEl) countEl.textContent = n;
    const mini = pill.querySelector('.pill-mini');
    if (mini && window.app?.activeSessionId) {
      const active = window.app.sessions?.get(window.app.activeSessionId);
      const name = active?.name || window.app.activeSessionId?.slice(0, 4) || '—';
      mini.textContent = name;
    }
    pill.setAttribute('aria-expanded', this.isOpen() ? 'true' : 'false');
  },
  isOpen() {
    const s = document.getElementById('mobileTabSheet');
    return s && s.classList.contains('open');
  },
  toggle(open) {
    const sheet = document.getElementById('mobileTabSheet');
    const scrim = document.getElementById('mobileTabScrim');
    const pill = document.getElementById('mobileTabPill');
    if (!sheet || !scrim) return;
    const willOpen = typeof open === 'boolean' ? open : !sheet.classList.contains('open');
    sheet.classList.toggle('open', willOpen);
    scrim.classList.toggle('open', willOpen);
    if (pill) pill.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      this.render();
      setTimeout(() => document.getElementById('mobileTabSearch')?.focus(), 180);
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  },
  render() {
    const listEl = document.getElementById('mobileTabList');
    const countEl = document.querySelector('#mobileTabSheet .sheet-count');
    const footEl = document.querySelector('#mobileTabSheet .sheet-footer-count');
    if (!listEl || !window.app) return;
    const app = window.app;
    const sessions = app.sessions;
    const activeId = app.activeSessionId;
    const filtering = this._filter !== 'all' || (this._q || '').length > 0;
    // Filtered matches temporarily ignore mobile collapse without saving state.
    const projection = this._mobileProjection();
    const editable = projection !== null;
    const focusCollapsed = filtering ? false : this._mobileFocusCollapsed();
    const collapsedIds = filtering ? [] : this._mobileCollapsedGroupIds();
    const sections = editable ? projection.sections : this._mobileFallbackSections();
    const allFocusIds = editable ? (projection.focusRefs || []).map((ref) => ref.id) : [];

    const itemFor = (id) => {
      let session = null;
      try {
        session = sessions?.get?.(id) ?? null;
      } catch {
        session = null;
      }
      if (!session) return null;
      const { status, alert } = this._classifySession(id, session);
      const item = { id, session, status, alert };
      if (!this._matchesMobileFilters(item)) return null;
      return item;
    };

    const focusHeaderItems = allFocusIds.map(itemFor).filter(Boolean);
    const renderedFocus = focusCollapsed ? [] : focusHeaderItems;
    // Focus renders as a shortcut section AND sessions remain in their
    // canonical group/Ungrouped section (desktop-rail parity). Focus
    // membership is driven purely off projection focusRefs — never off
    // item.session.focus. When Focus is collapsed, only the header renders
    // (zero rows) so the section stays expandable, mirroring collapsed
    // named groups.
    const renderedGroups = [];
    for (const section of sections) {
      const refs = Array.isArray(section?.refs) ? section.refs : [];
      const items = refs
        .filter((ref) => ref && ref.kind === 'session')
        .map((ref) => itemFor(ref.id))
        .filter(Boolean);
      if (items.length === 0) continue;
      const isUngrouped = section.id === null || section.id === undefined;
      const isCollapsed = !filtering && !isUngrouped && collapsedIds.includes(section.id);
      renderedGroups.push({ section, items, isCollapsed });
    }
    const renderedCount =
      renderedFocus.length +
      renderedGroups.reduce((sum, group) => sum + (group.isCollapsed ? 0 : group.items.length), 0);
    const totalLive = (() => {
      try {
        return sessions && typeof sessions.keys === 'function' ? [...sessions.keys()].length : 0;
      } catch {
        return 0;
      }
    })();

    if (countEl) countEl.textContent = renderedCount + ' / ' + totalLive;
    if (footEl) footEl.textContent = renderedCount + ' tabs';
    const updateCountEl = document.querySelector('#mobileTabPill .pill-count');
    if (updateCountEl) updateCountEl.textContent = String(totalLive);
    if (renderedCount === 0) {
      listEl.innerHTML = `<div style="padding:28px;text-align:center;color:#98a2b1;font-size:.85rem">No tabs match<br><small>Try All or clear search</small></div>`;
      return;
    }

    const html = [];
    if (focusHeaderItems.length > 0) {
      html.push(
        `<div class="sheet-group" data-sheet-focus-group>` +
          `<div class="sheet-group-header"><button type="button" class="sheet-group-toggle" aria-label="${focusCollapsed ? 'Expand' : 'Collapse'} Focus" aria-expanded="${focusCollapsed ? 'false' : 'true'}" onclick="MobileTabSheet.toggleMobileFocusCollapsed()"><span class="chev">▾</span></button>` +
          `<span class="sheet-group-name">Focus</span><span class="sheet-group-count">${focusHeaderItems.length}</span></div>` +
          (focusCollapsed ? '' : renderedFocus.map((item) => this._mobileSheetRow(item, activeId)).join('')) +
          `</div>`
      );
    }
    for (const { section, items, isCollapsed } of renderedGroups) {
      const isUngrouped = section.id === null || section.id === undefined;
      const label = isUngrouped ? 'Ungrouped' : section.name || 'Ungrouped';
      const toggleAttr = isUngrouped
        ? ''
        : `<button type="button" class="sheet-group-toggle" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} ${label}" aria-expanded="${isCollapsed ? 'false' : 'true'}" data-sheet-group-header="${this._mobileEscapeAttr(section.id)}" onclick="MobileTabSheet.toggleMobileGroupCollapsed(this.dataset.sheetGroupHeader)"><span class="chev">▾</span></button>`;
      // Header counts reflect rendered live sessions for this section, not
      // the stored layout count (which can include stale removed IDs).
      const visibleItems = items;
      const shownItems = [...visibleItems];
      if (shownItems.length === 0) continue;
      html.push(
        `<div class="sheet-group" data-sheet-group-id="${this._mobileEscapeAttr(section.id ?? '')}">` +
          `<div class="sheet-group-header">${toggleAttr}<span class="sheet-group-name">${label}</span><span class="sheet-group-count">${shownItems.length}</span></div>` +
          (isCollapsed ? '' : shownItems.map((item) => this._mobileSheetRow(item, activeId)).join('')) +
          `</div>`
      );
    }
    listEl.innerHTML = html.join('');
  },
  activate(id) {
    try {
      window.app.selectSession(id);
    } catch {}
    this.toggle(false);
  },
  closeTab(id) {
    try {
      window.app.closeSession?.(id) || window.app.killSession?.(id);
    } catch {}
    setTimeout(() => this.render(), 300);
  },
};
// Auto-init after DOM
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => MobileTabSheet.init());
else MobileTabSheet.init();
window.MobileTabSheet = MobileTabSheet;
