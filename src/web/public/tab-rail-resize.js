/** @fileoverview Accessible, device-local vertical session-rail sizing. */

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
    const fromCss = Number.parseFloat(document.documentElement.style.getPropertyValue('--tab-rail-width'));
    if (Number.isFinite(fromCss)) return fromCss;
    const measured = document.getElementById('tabRail')?.getBoundingClientRect?.().width;
    return Number.isFinite(measured) && measured > 0 ? measured : window.CodemanTabRail?.DEFAULT_WIDTH || 256;
  },

  readTabRailWidthSetting() {
    const select = document.getElementById('appSettingsTabRailWidth');
    if (!select) return this._getCurrentTabRailWidth();
    if (select.value === 'custom') return Number(select.dataset.currentWidth) || this._getCurrentTabRailWidth();
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
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (this._resizeTimeout) clearTimeout(this._resizeTimeout);
    this._resizeRaf = null;
    this._resizeTimeout = null;
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
    if (typeof requestAnimationFrame === 'function') {
      this._tabRailReleaseRaf = requestAnimationFrame(() => {
        this._tabRailReleaseRaf = requestAnimationFrame(release);
      });
      this._tabRailReleaseTimer = setTimeout(release, 250);
    } else release();
  },

  _scheduleTabRailSettle(effective, preferred = effective) {
    clearTimeout(this._tabRailSettleTimer);
    this._tabRailSettleTimer = setTimeout(async () => {
      this._tabRailSettleTimer = null;
      this._persistTabRailWidth(preferred);
      try {
        if (this.activeSessionId && this.sendResize) await this.sendResize(this.activeSessionId);
        else this.fitAddon?.fit();
        this._updateConnectionLinesImmediate?.();
      } catch (error) {
        console.warn('Failed to resize terminal after rail resize:', error);
      } finally {
        this._releaseTabRailResize();
      }
    }, 150);
  },

  applyTabRailWidth(options = {}) {
    const settings = this.loadAppSettingsFromStorage();
    const requested = settings.tabRailWidth ?? window.CodemanTabRail?.DEFAULT_WIDTH ?? 256;
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
    return proposed && proposed.cols < 40 ? this._setTabRailWidth(previous) : width;
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
    const preferred = window.CodemanTabRail?.resolveWidth({ width: this._tabRailDragWidth }) ?? this._tabRailDragWidth;
    this._scheduleTabRailSettle(this._tabRailDragWidth || this._getCurrentTabRailWidth(), preferred);
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
    const effective = this._setTabRailWidth(width);
    this._scheduleTabRailSettle(effective, window.CodemanTabRail.resolveWidth({ width }));
  },

  initTabRailResize() {
    const handle = document.getElementById('tabRailResizeHandle');
    if (!handle || handle.dataset.ready === '1') return;
    handle.dataset.ready = '1';
    this.applyTabRailWidth();
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
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
      if (handle.hasPointerCapture?.(event.pointerId)) this._queueTabRailPointerWidth(event.clientX);
    });
    handle.addEventListener('pointerup', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('pointercancel', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('lostpointercapture', (event) => this._finishTabRailDrag(handle, event.pointerId));
    handle.addEventListener('keydown', (event) => this._onTabRailKeyDown(event));
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this._claimTabRailResize();
      const preferred = window.CodemanTabRail?.DEFAULT_WIDTH || 256;
      const effective = this._setTabRailWidth(preferred);
      this._scheduleTabRailSettle(effective, preferred);
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.applyTabOrientation?.();
        this.applyTabRailWidth({ persist: false });
      }, 100);
    });
  },
});
