/**
 * @fileoverview COD-299 — accessible, device-local vertical session-rail sizing.
 *
 * Width policy is pure in constants.js. This mixin owns DOM interaction,
 * persistence, and the one settled terminal resize sent after a gesture.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp)
 * @dependency constants.js (window.CodemanTabRail)
 */

Object.assign(CodemanApp.prototype, {
  _getTabRailMinimumTerminalWidth() {
    const cellWidth = this.terminal?._core?._renderService?.dimensions?.css?.cell?.width;
    if (Number.isFinite(cellWidth) && cellWidth > 0) return Math.ceil(cellWidth * 40 + 24);
    return 420;
  },

  _getTabRailBounds() {
    const main = document.querySelector('.main');
    return {
      viewportWidth: window.innerWidth,
      mainWidth: main?.clientWidth || window.innerWidth,
      minTerminalWidth: this._getTabRailMinimumTerminalWidth(),
    };
  },

  _getCurrentTabRailWidth() {
    const fromCss = parseFloat(document.documentElement.style.getPropertyValue('--tab-rail-width'));
    if (Number.isFinite(fromCss)) return fromCss;
    const measured = document.getElementById('tabRail')?.getBoundingClientRect?.().width;
    return Number.isFinite(measured) && measured > 0 ? measured : window.CodemanTabRail?.DEFAULT_WIDTH || 256;
  },

  readTabRailWidthSetting() {
    const select = document.getElementById('appSettingsTabRailWidth');
    if (!select) return this._getCurrentTabRailWidth();
    if (select.value === 'custom') {
      return Number(select.dataset.currentWidth) || this._getCurrentTabRailWidth();
    }
    return Number(select.value) || window.CodemanTabRail?.DEFAULT_WIDTH || 256;
  },

  syncTabRailWidthSetting(width) {
    const select = document.getElementById('appSettingsTabRailWidth');
    if (!select) return;
    const rounded = Math.round(width);
    select.dataset.currentWidth = String(rounded);
    const preset = select.querySelector(`option[value="${rounded}"]`);
    if (preset) {
      select.value = String(rounded);
      return;
    }
    const custom = select.querySelector('option[value="custom"]');
    if (custom) custom.textContent = `Custom (${rounded}px)`;
    select.value = 'custom';
  },

  _setTabRailWidth(width) {
    const policy = window.CodemanTabRail;
    if (!policy) return 256;
    const bounds = this._getTabRailBounds();
    const resolved = policy.resolveWidth({ width, ...bounds });
    const effectiveMax = policy.resolveWidth({ width: policy.MAX_WIDTH, ...bounds });
    const root = document.documentElement;
    root.style.setProperty('--tab-rail-width', `${resolved}px`);
    root.classList.toggle('tab-rail-compact', resolved < 240);
    const handle = document.getElementById('tabRailResizeHandle');
    if (handle) {
      handle.setAttribute('aria-valuemax', String(effectiveMax));
      handle.setAttribute('aria-valuenow', String(resolved));
    }
    this.syncTabRailWidthSetting(resolved);
    return resolved;
  },

  _persistTabRailWidth(width) {
    const settings = this.loadAppSettingsFromStorage();
    if (settings.tabRailWidth === width) return;
    settings.tabRailWidth = width;
    this.saveAppSettingsToStorage(settings);
  },

  _claimTabRailResize() {
    this._tabRailResizeOwnsObserver = true;
    clearTimeout(this._tabRailResizeWatchdog);
    clearTimeout(this._tabRailReleaseTimer);
    if (this._tabRailReleaseRaf) cancelAnimationFrame(this._tabRailReleaseRaf);
    this._tabRailResizeWatchdog = setTimeout(() => {
      this._tabRailResizeWatchdog = null;
      this._tabRailResizeOwnsObserver = false;
    }, 1000);
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }
    if (this._resizeTimeout) {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = null;
    }
  },

  _releaseTabRailResize() {
    clearTimeout(this._tabRailResizeWatchdog);
    this._tabRailResizeWatchdog = null;
    const release = () => {
      clearTimeout(this._tabRailReleaseTimer);
      this._tabRailReleaseTimer = null;
      this._tabRailReleaseRaf = null;
      this._tabRailResizeOwnsObserver = false;
    };
    // Keep ownership through the ResizeObserver delivery caused by fit(). A
    // timer fallback still releases it when background tabs pause animation.
    if (typeof requestAnimationFrame === 'function') {
      this._tabRailReleaseRaf = requestAnimationFrame(() => {
        this._tabRailReleaseRaf = requestAnimationFrame(release);
      });
      this._tabRailReleaseTimer = setTimeout(release, 250);
    } else release();
  },

  _scheduleTabRailSettle(width, preferredWidth = width) {
    clearTimeout(this._tabRailSettleTimer);
    this._tabRailSettleTimer = setTimeout(async () => {
      this._tabRailSettleTimer = null;
      this._persistTabRailWidth(preferredWidth);
      try {
        if (this.activeSessionId && this.sendResize) {
          await this.sendResize(this.activeSessionId);
        } else {
          this.fitAddon?.fit();
        }
        this._updateConnectionLinesImmediate?.();
      } catch (err) {
        console.warn('Failed to resize terminal after rail resize:', err);
      } finally {
        this._releaseTabRailResize();
      }
    }, 150);
  },

  applyTabRailWidth(options = {}) {
    const settings = this.loadAppSettingsFromStorage();
    const requested = settings.tabRailWidth ?? window.CodemanTabRail?.DEFAULT_WIDTH ?? 256;
    // Preserve a user's preferred width when a narrow viewport temporarily
    // forces a smaller effective width. Only static corruption is normalized.
    const preferred = window.CodemanTabRail?.resolveWidth({ width: requested }) ?? 256;
    if (options.settle) this._claimTabRailResize();
    const resolved = this._setTabRailWidth(preferred);
    if (options.persist !== false && requested !== preferred) this._persistTabRailWidth(preferred);
    if (options.settle) this._scheduleTabRailSettle(resolved, preferred);
    return resolved;
  },

  _applyTabRailPointerWidth(clientX) {
    const main = document.querySelector('.main');
    if (!main) return this._getCurrentTabRailWidth();
    const previous = this._getCurrentTabRailWidth();
    const width = this._setTabRailWidth(clientX - main.getBoundingClientRect().left);
    let proposed = null;
    try {
      proposed = this.fitAddon?.proposeDimensions?.();
    } catch {}
    if (proposed && proposed.cols < 40) {
      return this._setTabRailWidth(previous);
    }
    return width;
  },

  _queueTabRailPointerWidth(clientX) {
    this._tabRailPendingClientX = clientX;
    if (this._tabRailPointerRaf) return;
    this._tabRailPointerRaf = requestAnimationFrame(() => {
      this._tabRailPointerRaf = null;
      this._tabRailDragWidth = this._applyTabRailPointerWidth(this._tabRailPendingClientX);
    });
  },

  _finishTabRailDrag(handle, pointerId) {
    if (!document.body.classList.contains('tab-rail-resizing')) return;
    if (this._tabRailPointerRaf) {
      cancelAnimationFrame(this._tabRailPointerRaf);
      this._tabRailPointerRaf = null;
      this._tabRailDragWidth = this._applyTabRailPointerWidth(this._tabRailPendingClientX);
    }
    document.body.classList.remove('tab-rail-resizing');
    const shield = document.getElementById('tabRailResizeShield');
    if (shield) shield.hidden = true;
    try {
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {}
    this._scheduleTabRailSettle(this._tabRailDragWidth || this._getCurrentTabRailWidth());
  },

  _onTabRailKeyDown(event) {
    const width = window.CodemanTabRail?.resolveKeyboardWidth({
      key: event.key,
      shiftKey: event.shiftKey,
      currentWidth: this._getCurrentTabRailWidth(),
      ...this._getTabRailBounds(),
    });
    if (width === null || width === undefined) return;
    event.preventDefault();
    this._claimTabRailResize();
    this._setTabRailWidth(width);
    this._scheduleTabRailSettle(width);
  },

  initTabRailResize() {
    const handle = document.getElementById('tabRailResizeHandle');
    if (!handle || handle.dataset.ready === '1') return;
    handle.dataset.ready = '1';
    this.applyTabRailWidth();

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.closeTabRailActionMenu();
      this._claimTabRailResize();
      this._tabRailDragWidth = this._getCurrentTabRailWidth();
      this._tabRailPendingClientX = event.clientX;
      document.body.classList.add('tab-rail-resizing');
      const shield = document.getElementById('tabRailResizeShield');
      if (shield) shield.hidden = false;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        document.body.classList.remove('tab-rail-resizing');
        if (shield) shield.hidden = true;
        this._releaseTabRailResize();
      }
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture?.(event.pointerId)) return;
      this._claimTabRailResize();
      this._queueTabRailPointerWidth(event.clientX);
    });
    handle.addEventListener('pointerup', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('pointercancel', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('lostpointercapture', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('keydown', (event) => this._onTabRailKeyDown(event));
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this._claimTabRailResize();
      const width = this._setTabRailWidth(window.CodemanTabRail?.DEFAULT_WIDTH || 256);
      this._scheduleTabRailSettle(width);
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.applyTabRailWidth(), 100);
    });
  },

  closeTabRailActionMenu(options = {}) {
    const menu = document.querySelector('.tab-rail-action-menu');
    const trigger = this._tabRailActionMenuTrigger;
    menu?.remove();
    if (this._tabRailActionMenuOutside) {
      document.removeEventListener('pointerdown', this._tabRailActionMenuOutside, true);
      this._tabRailActionMenuOutside = null;
    }
    this._tabRailActionMenuTrigger = null;
    if (options.restoreFocus) trigger?.focus?.();
  },

  openTabRailActionMenu(event, sessionId) {
    event.preventDefault();
    event.stopPropagation();
    this.closeTabRailActionMenu();
    const trigger = event.currentTarget;
    const menu = document.createElement('div');
    menu.className = 'tab-rail-action-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Session actions');
    const settings = this.loadAppSettingsFromStorage();
    const ref = { kind: 'session', id: sessionId };
    const placementActions =
      this._tabRefMoveActions?.(ref).map((destination) => ({
        label: destination.label,
        run: () => this.moveTabRefToGroup(ref, destination.groupId, destination.index),
      })) || [];
    placementActions.unshift(...(this._tabRefPlacementActions?.(ref) || []));
    const actions = [
      { label: 'Session options', run: () => this.openSessionOptions(sessionId) },
      ...placementActions,
      ...(settings.showTabDetachButton || this.detachedSessions?.has(sessionId)
        ? [{ label: 'Open in a new window', run: () => this.detachSession(sessionId) }]
        : []),
      { label: 'Close session', className: 'danger', run: () => this.requestCloseSession(sessionId) },
    ];
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = action.label;
      if (action.disabled) {
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('tab-placement-summary');
      }
      if (action.className) button.className = action.className;
      button.addEventListener('click', () => {
        if (action.disabled) return;
        this.closeTabRailActionMenu();
        action.run();
      });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8))}px`;
    this._tabRailActionMenuTrigger = trigger;
    this._tabRailActionMenuOutside = (pointerEvent) => {
      if (!menu.contains(pointerEvent.target) && pointerEvent.target !== trigger) this.closeTabRailActionMenu();
    };
    document.addEventListener('pointerdown', this._tabRailActionMenuOutside, true);
    menu.addEventListener('keydown', (keyEvent) => {
      const buttons = [...menu.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        this.closeTabRailActionMenu({ restoreFocus: true });
      } else if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
        keyEvent.preventDefault();
        const direction = keyEvent.key === 'ArrowDown' ? 1 : -1;
        buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      }
    });
    menu.querySelector('button')?.focus();
  },
});
