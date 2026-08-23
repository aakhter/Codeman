/**
 * @fileoverview Mobile Tab Sheet — bottom sheet for 10+ tabs on phones.
 * Shows a pill "12 tabs ▼" in header when count>8 on <430px, opens 70vh sheet with search + filters.
 * Reuses existing tabAlert/pendingHooks styling. Loaded after app.js.
 * @loadorder after app.js
 */

const MobileTabSheet = {
  _filter: 'all',
  _q: '',
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
    try {
      // Use <=430 to include iPhone Pro Max (430) which isMobile() excludes (strict <430)
      if (window.MobileDetection) {
        const w = window.innerWidth;
        if (w <= 430) return true;
        return MobileDetection.isMobile();
      }
    } catch {}
    return window.innerWidth <= 430 || window.innerWidth < 768;
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
      pill.onclick = () => this.toggle(true);
      brand.insertAdjacentElement('afterend', pill);
    }
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
    // Swipe down to close
    const sheet = document.getElementById('mobileTabSheet');
    let startY = 0;
    sheet.addEventListener(
      'touchstart',
      (e) => {
        startY = e.touches[0].clientY;
      },
      { passive: true }
    );
    sheet.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches[0].clientY - startY > 50) this.toggle(false);
      },
      { passive: true }
    );
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
    const n = window.app?.sessionOrder?.length || 0;
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
      mini.textContent = name.slice(0, 8);
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
    const order = window.app.sessionOrder || [];
    const sessions = window.app.sessions;
    const tabAlerts = window.app.tabAlerts;
    const pendingHooks = window.app.pendingHooks;
    let items = order
      .map((id) => {
        const s = sessions.get(id);
        if (!s) return null;
        const alert = tabAlerts?.get(id);
        const hooks = pendingHooks?.get(id);
        let status = 'idle';
        if (alert === 'action' || hooks?.has('permission_prompt') || hooks?.has('elicitation_dialog'))
          status = 'action';
        else if (alert === 'idle' || hooks?.has('idle_prompt')) status = 'idle';
        else if (s.status === 'busy' || s.isWorking) status = 'busy';
        else status = 'idle';
        // busy green pulsing is separate from idle yellow
        return { id, session: s, status, alert };
      })
      .filter(Boolean);

    // filter
    const q = this._q;
    items = items.filter((it) => {
      if (this._filter === 'needs' && it.status !== 'action') return false;
      if (this._filter === 'working' && it.status !== 'busy') return false;
      if (this._filter === 'idle' && it.status !== 'idle') return false;
      if (
        q &&
        !it.session.name?.toLowerCase().includes(q) &&
        !it.id.toLowerCase().includes(q) &&
        !(it.session.mode || '').toLowerCase().includes(q)
      )
        return false;
      return true;
    });

    // sort: needs first, then working, then active, then rest (keep order for rest)
    const activeId = window.app.activeSessionId;
    items.sort((a, b) => {
      const rank = (s) => (s.status === 'action' ? 0 : s.status === 'busy' ? 1 : s.id === activeId ? 2 : 3);
      return rank(a) - rank(b);
    });

    if (countEl) countEl.textContent = items.length + ' / ' + order.length;
    if (footEl) footEl.textContent = items.length + ' tabs';
    if (items.length === 0) {
      listEl.innerHTML = `<div style="padding:28px;text-align:center;color:#98a2b1;font-size:.85rem">No tabs match<br><small>Try All or clear search</small></div>`;
      return;
    }
    listEl.innerHTML = items
      .map((it) => {
        const s = it.session;
        const isActive = it.id === activeId;
        const dotClass =
          it.status === 'busy'
            ? 'busy'
            : it.status === 'action'
              ? 'action'
              : it.status === 'idle' && it.alert === 'idle'
                ? 'idle'
                : '';
        const mode = s.mode || 'claude';
        const name = s.name || it.id.slice(0, 8);
        const branch = name.includes('-') ? name.split('-').slice(1).join('-') : '';
        return `<div class="sheet-row ${isActive ? 'active' : ''}" onclick="MobileTabSheet.activate('${it.id}')">
        <span class="dot ${dotClass}"></span>
        <div class="row-info"><div class="row-name">${name}</div><div class="row-meta">${branch || mode} · ${mode}</div></div>
        <span class="badge ${mode}">${mode.slice(0, 2)}</span>
        ${it.status === 'action' ? '<span class="row-needs">● needs</span>' : ''}
        ${it.status === 'busy' ? '<span class="row-working">● working</span>' : ''}
        <button class="row-close" onclick="event.stopPropagation();MobileTabSheet.closeTab('${it.id}')" aria-label="Close">×</button>
      </div>`;
      })
      .join('');
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
