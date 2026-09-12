/**
 * @fileoverview Mobile device support: detection, keyboard handling, and swipe navigation.
 *
 * Defines three singleton objects that manage mobile-specific behavior:
 *
 * - MobileDetection — Device type detection (mobile/tablet/desktop), touch capability,
 *   iOS/Safari identification, and body class management for CSS targeting.
 * - KeyboardHandler — Virtual keyboard show/hide detection via visualViewport API,
 *   toolbar/accessory bar repositioning, terminal resize on keyboard open/close,
 *   and input scroll-into-view. Uses 100px threshold for iOS address bar drift.
 * - SwipeHandler — Horizontal swipe detection on the terminal area for session switching.
 *   80px minimum distance, 300ms maximum time, 100px max vertical drift.
 *
 * All three have init()/cleanup() lifecycle methods. They are re-initialized after SSE
 * reconnect (in handleInit) to prevent stale closures.
 *
 * @globals {object} MobileDetection
 * @globals {object} KeyboardHandler
 * @globals {object} SwipeHandler
 *
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar reference in KeyboardHandler.onKeyboardShow, soft — guarded with typeof check)
 * @loadorder 2 of 15 — loaded after constants.js, before voice-input.js
 */

const DEBUG_MOBILE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debugMobile');
function logViewport(label) {
  if (!DEBUG_MOBILE) return;
  const vv = window.visualViewport;
  console.log(
    `[mobile][${label}] innerHeight=${window.innerHeight} vv.h=${vv?.height} vv.scale=${vv?.scale} appHeight=${getComputedStyle(document.documentElement).getPropertyValue('--app-height')} dvh=${window.innerHeight}`
  );
}

// Codeman — Mobile detection, keyboard handling, and swipe navigation
// Loaded after constants.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Mobile Detection
// ═══════════════════════════════════════════════════════════════

/**
 * MobileDetection - Detects device type and touch capability.
 * Updates body classes for CSS targeting.
 */
const MobileDetection = {
  /** Check if device supports touch input */
  isTouchDevice() {
    return (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    );
  },

  /**
   * Check whether this browser belongs to a handheld device.
   *
   * Unlike getDeviceType(), this classification must remain stable when a
   * foldable changes posture. An unfolded phone can expose a desktop-width
   * viewport, but it still needs the same per-device settings that were saved
   * while folded. User-Agent Client Hints are preferred where available; the
   * legacy token fallback covers Android WebView and iPhone browsers.
   */
  isHandheldDevice() {
    if (!this.isTouchDevice()) return false;

    const userAgent = navigator.userAgent || '';

    // Prefer explicit UA form-factor signals. Besides matching real browsers,
    // this avoids Chromium emulation reporting userAgentData.mobile=true for
    // an iPad/tablet context created with isMobile=true.
    if (/iPad|Tablet|Silk|PlayBook|Kindle|Windows NT|CrOS|Macintosh/i.test(userAgent)) {
      return false;
    }
    if (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) return false;
    if (/Mobi|iPhone|iPod/i.test(userAgent)) return true;

    const uaDataMobile = navigator.userAgentData?.mobile;
    if (typeof uaDataMobile === 'boolean') return uaDataMobile;

    return false;
  },

  /** Check if device is iOS (iPhone, iPad, iPod) */
  isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  },

  /** Check if browser is Safari */
  isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  },

  /** Check if screen is small (phone-sized, <430px) */
  isSmallScreen() {
    return window.innerWidth < 430;
  },

  /** Check if screen is medium (tablet-sized, 430-768px) */
  isMediumScreen() {
    return window.innerWidth >= 430 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width < 430) return 'mobile';
    if (width < 768) return 'tablet';
    return 'desktop';
  },

  isMobile() {
    return this.getDeviceType() === 'mobile';
  },

  /** Update body classes based on device detection */
  updateBodyClass() {
    const body = document.body;
    const deviceType = this.getDeviceType();
    const isTouch = this.isTouchDevice();

    // Remove existing device classes
    body.classList.remove(
      'device-mobile',
      'device-tablet',
      'device-desktop',
      'touch-device',
      'ios-device',
      'safari-browser'
    );

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
    }

    // Add iOS-specific class for safe area handling
    if (this.isIOS()) {
      body.classList.add('ios-device');
    }

    // Add Safari class for browser-specific fixes
    if (this.isSafari()) {
      body.classList.add('safari-browser');
    }
  },

  /** Set --app-height CSS variable from visual viewport.
   *  On iPad Safari with tabs, 100vh extends behind the tab bar.
   *  visualViewport.height reflects the actual visible area.
   *  COD-283: always update --app-height, even with keyboardVisible, so dvh/app-height stays synced.
   *  KeyboardHandler still applies translateY/paddingBottom on top. */
  updateAppHeight() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
    // How far the layout viewport (which anchors position: fixed) extends below
    // the visual viewport, i.e. behind the browser's bottom bar. 0 on iPhone
    // Safari, where fixed elements already stop above the bar; the overlap
    // where they do not. mobile.css lifts the toolbar by this rather than by
    // (100vh - --app-height), which on iPhone measures the collapsible chrome
    // instead and left an empty band between the toolbar and the bar.
    // ⚠️ While the on-screen keyboard is up the visual viewport is the shrunken
    // area ABOVE it, which is not browser chrome — reporting that as overlap
    // would lift the toolbar by the keyboard's height on top of KeyboardHandler's
    // own translate, so it reads 0 there (COD-283 keeps --app-height itself live
    // in that state, which is why this cannot simply return early).
    const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
    document.documentElement.style.setProperty(
      '--chrome-overlap',
      keyboardUp ? '0px' : `${Math.max(0, window.innerHeight - h)}px`
    );
    if (typeof logViewport === 'function') logViewport('updateAppHeight');
  },

  /** Apply device-local font metrics before any resize listener can measure xterm. */
  syncTerminalFontPolicy() {
    try {
      if (typeof app !== 'undefined') app.applyTerminalFontPolicyForActiveSession?.();
    } catch {}
  },

  /** Initialize mobile detection and set up resize listener */
  init() {
    this.updateBodyClass();
    this.updateAppHeight();

    // Update --app-height on viewport resize (orientation, tab bar toggle).
    // Re-init can observe a different visualViewport object, so detach from
    // the exact target that owns the old callback before consulting the new one.
    if (this._appHeightHandler && this._appHeightTarget) {
      this._appHeightTarget.removeEventListener('resize', this._appHeightHandler);
      this._appHeightHandler = null;
      this._appHeightTarget = null;
    }
    if (window.visualViewport) {
      this._appHeightHandler = () => {
        this.updateAppHeight();
        this.syncTerminalFontPolicy();
      };
      this._appHeightTarget = window.visualViewport;
      this._appHeightTarget.addEventListener('resize', this._appHeightHandler);
    }

    // Debounced resize handler
    let resizeTimeout;
    this._resizeHandler = () => {
      // MobileDetection installs before the terminal resize listener. Apply
      // synchronously so its first rAF/fit cannot observe the old breakpoint.
      this.syncTerminalFontPolicy();
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.updateBodyClass();
        this.updateAppHeight();
        // Whether the session sidebar is a docked column or a modal overlay is
        // decided at 1024px, so crossing that width has to re-sync the drawer
        // state — otherwise the `inert`/aria-hidden set on a closed overlay
        // drawer survives into the docked rail and makes it unclickable.
        if (typeof app !== 'undefined') app.applySessionListLayout?.();
        // Tab auto-wrap is width-driven, so it must re-evaluate on resize — the only
        // other trigger is a tab content render. No-op on mobile/tablet (method bails).
        if (typeof app !== 'undefined') app.updateTabOverflowMode?.();
      }, 100);
    };
    window.addEventListener('resize', this._resizeHandler);

    // iOS: prevent pinch-to-zoom (Safari ignores user-scalable=no since iOS 10)
    if (this.isIOS()) {
      this._gestureStartHandler = (e) => e.preventDefault();
      this._gestureChangeHandler = (e) => e.preventDefault();
      document.addEventListener('gesturestart', this._gestureStartHandler);
      document.addEventListener('gesturechange', this._gestureChangeHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._appHeightHandler && this._appHeightTarget) {
      this._appHeightTarget.removeEventListener('resize', this._appHeightHandler);
      this._appHeightHandler = null;
      this._appHeightTarget = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._gestureStartHandler) {
      document.removeEventListener('gesturestart', this._gestureStartHandler);
      document.removeEventListener('gesturechange', this._gestureChangeHandler);
      this._gestureStartHandler = null;
      this._gestureChangeHandler = null;
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Handler
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardHandler - Simple handler to scroll inputs into view when keyboard appears.
 * Uses focusin event and scrollIntoView - keeps it simple and reliable.
 * Also handles terminal scrolling and toolbar repositioning via visualViewport API.
 */
const KeyboardHandler = {
  VIEWPORT_SETTLE_MS: 80,
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,
  _viewportSettleTimer: null,
  _settleRestoreScroll: false,
  _settlePending: false,
  // Scroll intent captured at the start of a settle cycle (#259). `true` =
  // following live output, `false` = reading history and _settleAnchorY holds
  // the top visible line to return to.
  _settleFollowing: true,
  _settleAnchorY: null,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.lastViewportHeight = this.initialViewportHeight;

    // Simple focus handler - scroll input into view after keyboard appears
    this._focusinHandler = (e) => {
      const target = e.target;
      if (!this.isInputElement(target)) return;

      // Wait for keyboard animation, then scroll input into view
      setTimeout(() => {
        this.scrollInputIntoView(target);
      }, 400);
    };
    document.addEventListener('focusin', this._focusinHandler);

    // Use visualViewport to detect keyboard and reposition toolbar
    if (window.visualViewport) {
      this._viewportResizeHandler = () => {
        this.handleViewportResize();
      };
      this._viewportScrollHandler = () => {
        this.updateLayoutForKeyboard();
      };
      window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
      // Also handle scroll (iOS scrolls viewport when keyboard appears)
      window.visualViewport.addEventListener('scroll', this._viewportScrollHandler);
    }

    // Prevent page-level scroll when keyboard is visible.
    // iOS Safari scrolls the document to bring xterm's hidden textarea into
    // view when the user types, pushing the entire UI off-screen. The CSS
    // position:fixed on .app prevents most cases, but reset as a safety net.
    this._windowScrollHandler = () => {
      if (this.keyboardVisible) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', this._windowScrollHandler);
  },

  /** Remove event listeners */
  cleanup() {
    if (this._focusinHandler) {
      document.removeEventListener('focusin', this._focusinHandler);
      this._focusinHandler = null;
    }
    if (this._viewportResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
      this._viewportResizeHandler = null;
    }
    if (this._viewportScrollHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', this._viewportScrollHandler);
      this._viewportScrollHandler = null;
    }
    if (this._windowScrollHandler) {
      window.removeEventListener('scroll', this._windowScrollHandler);
      this._windowScrollHandler = null;
    }
    if (this._viewportSettleTimer) {
      clearTimeout(this._viewportSettleTimer);
      this._viewportSettleTimer = null;
    }
    this._settleRestoreScroll = false;
    this._settlePending = false;
    this._settleFollowing = true;
    this._settleAnchorY = null;
  },

  /** Handle viewport resize (keyboard show/hide) */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const heightDiff = this.initialViewportHeight - currentHeight;

    // Keyboard appeared (viewport shrunk by more than 150px)
    if (heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      // While the keyboard is open, size the app to the visual viewport so
      // xterm's bottom row and cursor sit above the OS keyboard.
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (heightDiff < 100 && this.keyboardVisible) {
      this.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
      // Re-sync --app-height now that keyboard is gone (MobileDetection skipped
      // updates while keyboardVisible was true)
      MobileDetection.updateAppHeight();
    }

    // Update baseline when keyboard is not visible — adapts to address bar
    // state changes, orientation changes, and other viewport shifts
    if (!this.keyboardVisible) {
      this.initialViewportHeight = currentHeight;
    } else {
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
    }

    this.updateLayoutForKeyboard();
    this._deferViewportSettle();
    this.lastViewportHeight = currentHeight;
  },

  /** Update layout when keyboard shows/hides */
  updateLayoutForKeyboard() {
    if (!window.visualViewport) return;

    // Only adjust on mobile
    if (!MobileDetection.isSmallScreen() && !MobileDetection.isMediumScreen()) {
      this.resetLayout();
      return;
    }

    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const cjkInput = document.getElementById('cjkInput');
    const main = document.querySelector('.main');

    if (this.keyboardVisible) {
      // Calculate how far fixed bottom controls need to move to sit inside the
      // visual viewport. iOS keeps position:fixed anchored to the full layout
      // viewport while the keyboard is open, but Chromium/Android-style engines
      // often anchor fixed bars to the already-shrunken viewport. Measure the
      // untransformed toolbar bottom instead of assuming either browser model.
      const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
      if (toolbar) toolbar.style.transform = '';
      if (accessoryBar) accessoryBar.style.transform = '';
      if (cjkInput?.classList.contains('cjk-input-visible')) cjkInput.style.transform = '';
      const fixedBottom = toolbar?.getBoundingClientRect?.().bottom || window.innerHeight;
      const keyboardOffset = Math.max(0, fixedBottom - visualBottom);

      // Move toolbar and accessory bar above keyboard.
      // When keyboardOffset is 0 (viewport scrolled to layout bottom),
      // the bars are naturally positioned via their CSS bottom values —
      // just clear the transforms.  Never dismiss keyboard state here;
      // that's handleViewportResize's job.
      if (toolbar) {
        toolbar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
      }
      if (accessoryBar) {
        accessoryBar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
      }
      if (cjkInput?.classList.contains('cjk-input-visible')) {
        cjkInput.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
      }

      // Reserve only Codeman's visible controls. The OS keyboard is outside
      // the visual viewport; adding its height here creates a large blank area
      // above the mobile toolbar on iPhone. Measure the controls instead of
      // relying on a constant because toolbar height changes across phone
      // widths, safe-area padding, and button wrapping.
      // For OpenCode on small iPhones, collapse the toolbar to reclaim rows.
      const isOpencodeMobile = (() => {
        try {
          return (
            typeof app !== 'undefined' &&
            app.sessions?.get?.(app.activeSessionId)?.mode === 'opencode' &&
            MobileDetection.isMobile?.()
          );
        } catch {
          return false;
        }
      })();
      const vvH = window.visualViewport?.height || window.innerHeight;
      if (isOpencodeMobile && vvH < 350 && this.keyboardVisible) {
        // Hide toolbar to gain 40px (~3 rows) - accessory bar already gives dismiss
        if (toolbar) toolbar.style.display = 'none';
      } else if (toolbar) {
        toolbar.style.display = '';
      }
      const keyboardHeight = this.initialViewportHeight - (window.visualViewport.height || window.innerHeight);
      if (main && keyboardHeight > 0) {
        const cjkInputHeight = cjkInput?.classList.contains('cjk-input-visible') ? 44 : 0;
        const toolbarHeight =
          toolbar && toolbar.style.display !== 'none'
            ? toolbar?.offsetHeight || toolbar?.getBoundingClientRect?.().height || 40
            : 0;
        const accessoryHeight = accessoryBar?.classList.contains('visible')
          ? accessoryBar.offsetHeight || accessoryBar.getBoundingClientRect?.().height || 44
          : 0;
        main.style.paddingBottom = `${Math.ceil(toolbarHeight + accessoryHeight + cjkInputHeight)}px`;
      }
      // Font choice is stable across keyboard transitions. The viewport settle
      // below owns the fit after applying the active device/mode policy.
      try {
        if (typeof app !== 'undefined') app.applyTerminalFontPolicyForActiveSession?.();
      } catch {}
    } else {
      this.resetLayout();
    }
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const cjkInput = document.getElementById('cjkInput');
    const main = document.querySelector('.main');

    if (toolbar) {
      toolbar.style.transform = '';
      toolbar.style.display = '';
    }
    if (accessoryBar) {
      accessoryBar.style.transform = '';
      accessoryBar.style.bottom = '';
    }
    if (cjkInput) {
      cjkInput.style.transform = '';
      cjkInput.style.bottom = '';
    }
    if (main) {
      main.style.paddingBottom = '';
    }
    // Restore the active device/mode policy without writing storage or fitting.
    try {
      if (typeof app !== 'undefined') app.applyTerminalFontPolicyForActiveSession?.();
    } catch {}
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    // Show keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.show();
    }

    // Reset any page scroll that occurred during keyboard open.
    // iOS Safari may scroll the document to reveal xterm's hidden textarea.
    window.scrollTo(0, 0);

    // visualViewport emits multiple heights throughout the OS animation.
    // Re-schedule on every event and fit only after the final height settles.
    this._scheduleViewportSettle({ restoreScroll: true });

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    // Hide keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.hide();
    }

    this.resetLayout();

    this._scheduleViewportSettle({ restoreScroll: true });

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /**
   * Coalesce the keyboard animation into one final xterm reflow and PTY resize.
   * Only a real show/hide transition arms the settle work; ongoing viewport
   * resize events merely push a pending settle back (_deferViewportSettle).
   * A viewport change that never crosses the show/hide thresholds must not
   * refit: keyboard detection can miss a fine-grained OS animation entirely
   * (each step under 150px, with the baseline chasing the animation), and the
   * container is then mid-animation with no keyboard CSS compensation, so a
   * fit against it resizes the PTY to transient dims and the SIGWINCH thrash
   * garbles the transcript.
   */
  _scheduleViewportSettle({ restoreScroll = false } = {}) {
    // Capture scroll intent on the FIRST event of a settle cycle, BEFORE any
    // fit() has reflowed the buffer — a later capture reads an already-moved
    // viewportY. Issue #259: this path used to force scrollToBottom
    // unconditionally, so opening the keyboard yanked a user who was reading
    // history down to the live output.
    if (!this._settlePending) this._captureTerminalScrollIntent();
    this._settleRestoreScroll = this._settleRestoreScroll || restoreScroll;
    this._settlePending = true;
    this._armViewportSettleTimer();
  },

  /**
   * Record whether the terminal is following live output, and if not, the top
   * visible line to return to. `_settleFollowing` defaults to true so a
   * terminal we cannot read keeps the historical scroll-to-bottom behavior.
   */
  _captureTerminalScrollIntent() {
    this._settleFollowing = true;
    this._settleAnchorY = null;
    if (typeof app === 'undefined' || !app.terminal?.buffer?.active) return;
    this._settleFollowing = app.isTerminalAtBottom();
    if (!this._settleFollowing) this._settleAnchorY = app.terminal.buffer.active.viewportY;
  },

  /**
   * Return to the captured anchor after the keyboard reflow. Reflow can rewrap
   * lines, so the anchor is approximate by construction; it is clamped to the
   * post-reflow buffer rather than trusted blindly.
   */
  _restoreTerminalScrollIntent() {
    const term = typeof app !== 'undefined' ? app.terminal : null;
    const anchor = this._settleAnchorY;
    if (typeof anchor !== 'number' || typeof term?.scrollToLine !== 'function' || !term.buffer?.active) {
      term?.scrollToBottom?.();
      return;
    }
    term.scrollToLine(Math.max(0, Math.min(anchor, term.buffer.active.baseY)));
  },

  /** Push a pending settle back while the viewport is still animating; no-op otherwise. */
  _deferViewportSettle() {
    if (!this._settlePending) return;
    this._armViewportSettleTimer();
  },

  _armViewportSettleTimer() {
    if (this._viewportSettleTimer) clearTimeout(this._viewportSettleTimer);
    this._viewportSettleTimer = setTimeout(() => {
      this._viewportSettleTimer = null;
      this._settlePending = false;
      const shouldRestoreScroll = this._settleRestoreScroll;
      this._settleRestoreScroll = false;

      if (typeof app !== 'undefined' && app.terminal) {
        // COD-284: double-rAF waits for iOS to commit the keyboard layout,
        // then repaints its xterm canvas before notifying the PTY.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            try {
              app.applyTerminalFontPolicyForActiveSession?.();
            } catch {}
            if (app.fitAddon) {
              try {
                app.fitAddon.fit();
              } catch {}
            }
            if (this.keyboardVisible) this._shrinkPaddingToFit();
            try {
              app.terminal.refresh(0, Math.max(0, (app.terminal.rows || 24) - 1));
            } catch {}
            // Following live output → bottom, as before. Reading history → back to
            // the pre-reflow anchor instead of being yanked down (#259).
            // COD-187: never yank the frozen history view to the bottom either.
            if (shouldRestoreScroll) {
              if (this._settleFollowing === false || app._viewMode === 'history') this._restoreTerminalScrollIntent();
              else app.terminal.scrollToBottom();
            }
            app._syncMobileHelperTextareaToCursor?.();
            app._localEchoOverlay?.rerender?.();
            this._sendTerminalResize();
          })
        );
      }
      window.scrollTo(0, 0);
    }, this.VIEWPORT_SETTLE_MS);
  },

  /** Send current terminal dimensions to the server (one-shot, for keyboard open/close) */
  _sendTerminalResize() {
    if (
      typeof app === 'undefined' ||
      !app.activeSessionId ||
      typeof app.sendResize !== 'function' ||
      app._isTerminalSessionGone?.(app.activeSessionId) ||
      document.visibilityState === 'hidden'
    )
      return;
    try {
      // Keyboard settlement is passive geometry maintenance. Keep it on the
      // token-fenced WebSocket path so a delayed/hidden phone callback cannot
      // take sizing ownership back from the viewer the user is now using.
      const pending = app.sendResize(app.activeSessionId);
      pending?.catch?.(() => {});
    } catch {}
  },

  /**
   * Shrink .main paddingBottom to eliminate the terminal row quantization gap.
   * xterm can only render whole rows, so fractional-row pixels create dead
   * space below the last row. After fitAddon.fit(), measure the gap and
   * reduce padding by that amount so the terminal sits flush against the bars.
   * COD-284: never inflate the container itself; that corrupts iOS canvas sizing.
   */
  /**
   * Combined height of the fixed bars that overlay the terminal's bottom edge.
   *
   * On phones the toolbar and the accessory bar are `position: fixed`, so they
   * occupy no layout space of their own — `main`'s padding-bottom is the only
   * thing reserving room for them, and any pixel taken out of it is a pixel of
   * terminal painted underneath them.
   */
  _fixedBottomBarsHeight() {
    let px = 0;
    for (const selector of ['.toolbar', '.keyboard-accessory-bar', '#cjkInput.cjk-input-visible']) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle?.(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      px += el.offsetHeight || 0;
    }
    return px;
  },

  /**
   * Reclaim sub-row slack at the bottom of the terminal — but never the space the
   * fixed bars stand in.
   *
   * Shrinking the padding by the whole slack pulled the terminal's bottom edge
   * DOWN under those bars, and the row the following re-fit then gained was
   * painted behind them: on a long wrapped prompt the last line was clipped by
   * the accessory bar, i.e. the bottom half of the text being typed. The floor is
   * now the bars' MEASURED height, so a device where the hard-coded 84px
   * over-reserves still reclaims the difference, while one that genuinely needs
   * it keeps every pixel.
   *
   * ⚠️ The floor can only ever prevent a shrink, never cause a grow
   * (`Math.min(currentPadding, …)`): a measured height LARGER than the current
   * padding makes this a no-op rather than silently resizing the terminal.
   */
  _shrinkPaddingToFit() {
    try {
      const container = document.getElementById('terminalContainer') || document.querySelector('.terminal-container');
      const main = document.querySelector('.main');
      if (!container || !main || typeof app === 'undefined' || !app.terminal) return;
      const cellH = app.terminal._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellH) return;
      const gap = container.clientHeight - Math.floor(container.clientHeight / cellH) * cellH;
      if (gap > 2 && gap < cellH) {
        const currentPadding = parseInt(main.style.paddingBottom) || 0;
        const floor = Math.min(currentPadding, this._fixedBottomBarsHeight());
        main.style.paddingBottom = Math.max(floor, currentPadding - gap) + 'px';
        if (app.fitAddon)
          try {
            app.fitAddon.fit();
          } catch {}
      }
    } catch {}
  },

  /** Check if element is an input that triggers keyboard (excludes terminal) */
  isInputElement(el) {
    if (!el) return false;

    // Exclude xterm.js terminal inputs (they handle their own scroll)
    if (el.closest('.xterm') || el.closest('.terminal-container')) {
      return false;
    }

    const tagName = el.tagName?.toLowerCase();
    // Exclude type=range, type=checkbox, type=radio (don't trigger keyboard)
    if (tagName === 'input') {
      const type = el.type?.toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') {
        return false;
      }
    }
    return tagName === 'input' || tagName === 'textarea' || el.isContentEditable;
  },

  /** Scroll input into view above the keyboard */
  scrollInputIntoView(input) {
    // Check if input is still focused (user might have tapped away)
    if (document.activeElement !== input) return;

    // Find if we're in a modal
    const modal = input.closest('.modal.active');
    const modalBody = modal?.querySelector('.modal-body');

    if (modalBody) {
      // For modals - scroll within the modal body
      const inputRect = input.getBoundingClientRect();
      const modalRect = modalBody.getBoundingClientRect();

      // If input is below middle of modal, scroll it up
      if (inputRect.top > modalRect.top + modalRect.height * 0.4) {
        const scrollAmount = inputRect.top - modalRect.top - 100;
        modalBody.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } else {
      // For page-level - use scrollIntoView
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Swipe Handler
// ═══════════════════════════════════════════════════════════════

/**
 * SwipeHandler - Detects horizontal swipes on terminal to switch sessions.
 * Only active on mobile/touch devices.
 */
const SwipeHandler = {
  startX: 0,
  startY: 0,
  startTime: 0,
  minSwipeDistance: 80, // Minimum pixels for a valid swipe
  maxSwipeTime: 300, // Maximum ms for a swipe gesture
  maxVerticalDrift: 100, // Max vertical movement allowed

  _touchStartHandler: null,
  _touchEndHandler: null,
  _element: null,
  _ignoreGesture: false,

  /** Initialize swipe handling */
  init() {
    // Only on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    const terminal = document.querySelector('.main');
    if (!terminal) return;

    this._element = terminal;
    this._touchStartHandler = (e) => this.onTouchStart(e);
    this._touchEndHandler = (e) => this.onTouchEnd(e);
    terminal.addEventListener('touchstart', this._touchStartHandler, { passive: true });
    terminal.addEventListener('touchend', this._touchEndHandler, { passive: true });
  },

  /** Remove swipe listeners */
  cleanup() {
    if (this._element && this._touchStartHandler) {
      this._element.removeEventListener('touchstart', this._touchStartHandler);
      this._element.removeEventListener('touchend', this._touchEndHandler);
    }
    this._touchStartHandler = null;
    this._touchEndHandler = null;
    this._element = null;
  },

  onTouchStart(e) {
    // The session sidebar is an overlay child of .main, so its touches bubble in
    // here. Swiping across the open session drawer — the natural "dismiss it"
    // gesture — would otherwise fire nextSession() and drop the user into a
    // session they never tapped.
    this._ignoreGesture = !!e.target?.closest?.('.session-sidebar');
    if (this._ignoreGesture) return;
    if (!e.touches || e.touches.length !== 1) return;
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.startTime = Date.now();
  },

  onTouchEnd(e) {
    if (this._ignoreGesture) {
      this._ignoreGesture = false;
      return;
    }
    if (!e.changedTouches || e.changedTouches.length !== 1) return;

    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const elapsed = Date.now() - this.startTime;

    // Check if it's a valid swipe
    const deltaX = endX - this.startX;
    const deltaY = Math.abs(endY - this.startY);

    if (elapsed > this.maxSwipeTime) return; // Too slow
    if (deltaY > this.maxVerticalDrift) return; // Too much vertical movement
    if (Math.abs(deltaX) < this.minSwipeDistance) return; // Too short

    // Valid swipe detected
    if (deltaX > 0) {
      // Swipe right -> previous session
      if (typeof app !== 'undefined') app.prevSession();
    } else {
      // Swipe left -> next session
      if (typeof app !== 'undefined') app.nextSession();
    }
  },
};
