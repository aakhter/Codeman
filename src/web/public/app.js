/**
 * @fileoverview Core UI controller for Codeman — tab-based terminal manager with xterm.js.
 *
 * Defines the CodemanApp class (constructor, init, SSE connection, session lifecycle, tabs,
 * navigation). Domain-specific methods are mixed in from separate modules via Object.assign:
 *
 *   terminal-ui.js   — Terminal setup, rendering pipeline, controls
 *   respawn-ui.js    — Respawn banner, countdown timers, presets, run summary
 *   ralph-panel.js   — Ralph state panel, fix_plan, plan versioning
 *   settings-ui.js   — App settings, visibility, web push, lifecycle log, tunnel/QR, help
 *   panels-ui.js     — Subagent panel, agent teams, project insights, file browser, log viewer,
 *                       image popups, monitor, token stats, toast, system stats
 *   session-ui.js    — Quick start, session options modal, case settings, mobile case picker
 *   ralph-wizard.js  — Ralph Loop wizard modal
 *   api-client.js    — API helper methods (fetch wrappers)
 *   subagent-windows.js — Floating subagent terminal windows
 *
 * ═══ Sections in this file ═══
 *
 *   SSE Handler Map            — Event-to-method routing table (resolves at runtime via `this`)
 *   CodemanApp Class           — Constructor and all state initialization (~80 properties)
 *   Pending Hooks              — Hook state machine for tab alerts
 *   Init                       — App bootstrap, mobile setup, WebGL init
 *   Event Listeners            — Keyboard shortcuts, resize, beforeunload
 *   SSE Connection             — connectSSE with exponential backoff (1-30s)
 *   Core SSE Event Handlers    — Session lifecycle, scheduled runs (~20 handlers)
 *   Connection Status          — Online detection, input queuing, state sync
 *   WebSocket Terminal I/O     — Low-latency WS bypass for terminal input
 *   Session Tabs               — Tab rendering, selection, drag-and-drop reordering
 *   Tab Order & Drag-and-Drop  — Persistent ordering with localStorage sync
 *   Session Lifecycle          — Select, close, navigate, rename, cleanup
 *   Navigation                 — goHome
 *   Kill Sessions              — Kill active/all sessions
 *   Timer / Tokens             — Session timer, token/cost display
 *   Module Init                — localStorage migration, app instantiation
 *
 * @class CodemanApp
 * @globals {CodemanApp} app - Singleton instance (also on window.app)
 *
 * @dependency constants.js (SSE_EVENTS, timing constants, escapeHtml, DEC_SYNC_STRIP_RE)
 * @dependency mobile-handlers.js (MobileDetection, KeyboardHandler, SwipeHandler)
 * @dependency voice-input.js (VoiceInput, DeepgramProvider)
 * @dependency notification-manager.js (NotificationManager class)
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar, FocusTrap)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.iife.js (LocalEchoOverlay)
 * @loadorder 6 of 15 — loaded after keyboard-accessory.js, before terminal-ui.js
 */

// Codeman App - Tab-based Terminal UI
// Constants, utilities, and escapeHtml() are in constants.js (loaded before this file)
// MobileDetection, KeyboardHandler, SwipeHandler are in mobile-handlers.js
// DeepgramProvider, VoiceInput are in voice-input.js

// ═══════════════════════════════════════════════════════════════
// Global Error & Performance Diagnostics
// ═══════════════════════════════════════════════════════════════
// Writes breadcrumbs to localStorage so they survive tab freezes.
// After a crash, check: localStorage.getItem('codeman-crash-diag')

const _crashDiag = {
  _entries: [],
  _maxEntries: 50,
  // Per-page-load id: the server keys beacons by it, so a reload (fresh id)
  // archives the previous page's trail instead of overwriting it, and
  // concurrent clients (desktop + phone) don't clobber each other.
  _pageId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  log(msg) {
    const entry = `${new Date().toISOString().slice(11,23)} ${msg}`;
    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) this._entries.shift();
    try { localStorage.setItem('codeman-crash-diag', this._entries.join('\n')); } catch {}
  }
};

// Log previous crash breadcrumbs on startup, and re-beacon them under a
// distinct page id — an iOS PWA reload wipes the in-memory trail, and without
// this the fresh page's first beacon would be all the server ever sees.
try {
  const prev = localStorage.getItem('codeman-crash-diag');
  if (prev) {
    console.log('[CRASH-DIAG] Previous session breadcrumbs:\n' + prev);
    navigator.sendBeacon('/api/crash-diag', JSON.stringify({ data: prev, id: _crashDiag._pageId + '-prev' }));
  }
} catch {}
_crashDiag.log('PAGE LOAD');

// Heartbeat: send breadcrumbs to server every 2s so they survive tab freezes.
function _crashDiagBeacon() {
  try {
    if (_crashDiag._entries.length > 0) {
      navigator.sendBeacon('/api/crash-diag', JSON.stringify({ data: _crashDiag._entries.join('\n'), id: _crashDiag._pageId }));
    }
  } catch {}
}
setInterval(() => {
  try { localStorage.setItem('codeman-crash-heartbeat', String(Date.now())); } catch {}
  _crashDiagBeacon();
}, 2000);
// iOS suspends JS the instant the app is backgrounded — entries logged since
// the last 2s tick would sit unsent until (if ever) the page resumes. Flush
// immediately on hide so a repro right before an app switch is never lost.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _crashDiagBeacon();
});

// rAF heartbeat — counts animation frames so we can detect rAF starvation
// (compositor stuck, GPU process unhealthy) where longtask observer is silent
// because the main thread isn't busy, just waiting.
let _rafHeartbeatCount = 0;
let _rafHeartbeatLast = performance.now();
const _rafHeartbeat = () => { _rafHeartbeatCount++; requestAnimationFrame(_rafHeartbeat); };
requestAnimationFrame(_rafHeartbeat);

// Periodic state snapshot — runs in setInterval so it fires even when rAF is
// starved or SSE handlers stop firing. Only logs when something looks wrong,
// to avoid breadcrumb spam during normal operation.
setInterval(() => {
  try {
    const now = performance.now();
    const elapsed = now - _rafHeartbeatLast;
    _rafHeartbeatLast = now;
    const rafsPerSec = elapsed > 0 ? (_rafHeartbeatCount * 1000 / elapsed) : 0;
    _rafHeartbeatCount = 0;

    const app = window.app;
    const queued = (app?.pendingWrites?.reduce((s, w) => s + (w?.length || 0), 0) || 0)
      + (app?.flickerFilterBuffer?.length || 0);
    const sseState = app?.eventSource?.readyState ?? -1; // 0=connecting 1=open 2=closed
    const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;
    const vis = document.visibilityState[0]; // 'v' or 'h'
    const sessions = app?.sessions?.size ?? 0;

    // Log when abnormal:
    //   rAF starvation while tab visible (< 10/s, normal is ~60)
    //   render queue piling up (> 64KB)
    //   SSE not OPEN
    const abnormal =
      (vis === 'v' && rafsPerSec < 10) ||
      queued > 65536 ||
      sseState !== 1;
    // Throttle-floor heartbeat: log at most once per minute even when
    // everything looks normal so we can prove the main thread is alive
    // (helps distinguish true freezes from quiet operation).
    if (!_heartbeatFloorLast) _heartbeatFloorLast = 0;
    const sinceFloor = now - _heartbeatFloorLast;
    if (abnormal || sinceFloor > 60000) {
      _heartbeatFloorLast = now;
      _crashDiag.log(
        `HB raf=${rafsPerSec.toFixed(0)}/s q=${(queued/1024).toFixed(0)}KB sse=${sseState} h=${heapMB}MB ${vis} s=${sessions}`
      );
    }
  } catch {}
}, 1000);
let _heartbeatFloorLast = 0;

window.addEventListener('error', (e) => {
  _crashDiag.log(`ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
  console.error('[CRASH-DIAG] Uncaught error:', e.message, '\n  File:', e.filename, ':', e.lineno, ':', e.colno, '\n  Stack:', e.error?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  _crashDiag.log(`UNHANDLED: ${e.reason?.message || e.reason}`);
  console.error('[CRASH-DIAG] Unhandled promise rejection:', e.reason?.message || e.reason, '\n  Stack:', e.reason?.stack);
});

// Detect long tasks (>50ms main thread blocks) — these cause "page unresponsive"
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) {
          _crashDiag.log(`LONG_TASK: ${entry.duration.toFixed(0)}ms`);
          console.warn(`[CRASH-DIAG] Long task: ${entry.duration.toFixed(0)}ms (type: ${entry.entryType}, name: ${entry.name})`);
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch { /* longtask not supported */ }
}

// Track WebGL context loss/restore events on all canvases
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  const ctx = _origGetContext.call(this, type, ...args);
  if (type === 'webgl2' || type === 'webgl') {
    this.addEventListener('webglcontextlost', (e) => {
      _crashDiag.log(`WEBGL_LOST: ${this.width}x${this.height}`);
      console.error('[CRASH-DIAG] WebGL context LOST on canvas', this.width, 'x', this.height, '— prevented:', e.defaultPrevented);
    });
    this.addEventListener('webglcontextrestored', () => {
      _crashDiag.log('WEBGL_RESTORED');
      console.warn('[CRASH-DIAG] WebGL context restored');
    });
  }
  return ctx;
};


// ═══════════════════════════════════════════════════════════════
// SSE Handler Map — event-to-method routing table
// ═══════════════════════════════════════════════════════════════
// connectSSE() iterates this array to register all listeners in a single loop.
// Omitted no-op events (registered by server but unused in UI):
//   respawn:stepSent, respawn:aiCheckStarted, respawn:aiCheckCompleted,
//   respawn:aiCheckFailed, respawn:aiCheckCooldown
const _SSE_HANDLER_MAP = [
  // Core
  [SSE_EVENTS.INIT, '_onInit'],

  // Session lifecycle
  [SSE_EVENTS.SESSION_CREATED, '_onSessionCreated'],
  [SSE_EVENTS.SESSION_UPDATED, '_onSessionUpdated'],
  [SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted'],
  [SSE_EVENTS.SESSION_TERMINAL, '_onSSETerminal'],
  [SSE_EVENTS.SESSION_NEEDS_REFRESH, '_onSSENeedsRefresh'],
  [SSE_EVENTS.SESSION_RESIZED, '_onSessionResized'],
  [SSE_EVENTS.SESSION_CLEAR_TERMINAL, '_onSSEClearTerminal'],
  [SSE_EVENTS.SESSION_COMPLETION, '_onSessionCompletion'],
  [SSE_EVENTS.SESSION_ERROR, '_onSessionError'],
  [SSE_EVENTS.SESSION_EXIT, '_onSessionExit'],
  [SSE_EVENTS.SESSION_IDLE, '_onSessionIdle'],
  [SSE_EVENTS.SESSION_WORKING, '_onSessionWorking'],
  [SSE_EVENTS.SESSION_AUTO_CLEAR, '_onSessionAutoClear'],
  [SSE_EVENTS.SESSION_LIMIT_PAUSE_SCHEDULED, '_onSessionLimitPauseScheduled'],
  [SSE_EVENTS.SESSION_LIMIT_RESUME, '_onSessionLimitResume'],
  [SSE_EVENTS.SESSION_LIMIT_RESUME_CANCELLED, '_onSessionLimitResumeCancelled'],
  [SSE_EVENTS.SESSION_RESPAWN_BREAKER_TRIPPED, '_onSessionRespawnBreakerTripped'],
  [SSE_EVENTS.SESSION_CLI_INFO, '_onSessionCliInfo'],
  [SSE_EVENTS.SESSION_STATUS_TELEMETRY, '_onSessionStatusTelemetry'],

  // Scheduled runs
  [SSE_EVENTS.SCHEDULED_CREATED, '_onScheduledCreated'],
  [SSE_EVENTS.SCHEDULED_UPDATED, '_onScheduledUpdated'],
  [SSE_EVENTS.SCHEDULED_COMPLETED, '_onScheduledCompleted'],
  [SSE_EVENTS.SCHEDULED_STOPPED, '_onScheduledStopped'],

  // Scheduled jobs (cron-style scheduler)
  [SSE_EVENTS.CRON_JOBS_CHANGED, '_onCronJobsChanged'],
  [SSE_EVENTS.CRON_JOB_DELETED, '_onCronJobsChanged'],
  [SSE_EVENTS.CRON_RUN_CREATED, '_onCronRunChanged'],
  [SSE_EVENTS.CRON_RUN_UPDATED, '_onCronRunChanged'],

  // Respawn
  [SSE_EVENTS.RESPAWN_STARTED, '_onRespawnStarted'],
  [SSE_EVENTS.RESPAWN_STOPPED, '_onRespawnStopped'],
  [SSE_EVENTS.RESPAWN_STATE_CHANGED, '_onRespawnStateChanged'],
  [SSE_EVENTS.RESPAWN_CYCLE_STARTED, '_onRespawnCycleStarted'],
  [SSE_EVENTS.RESPAWN_BLOCKED, '_onRespawnBlocked'],
  [SSE_EVENTS.RESPAWN_AUTO_ACCEPT_SENT, '_onRespawnAutoAcceptSent'],
  [SSE_EVENTS.RESPAWN_DETECTION_UPDATE, '_onRespawnDetectionUpdate'],
  [SSE_EVENTS.RESPAWN_TIMER_STARTED, '_onRespawnTimerStarted'],
  [SSE_EVENTS.RESPAWN_TIMER_CANCELLED, '_onRespawnTimerCancelled'],
  [SSE_EVENTS.RESPAWN_TIMER_COMPLETED, '_onRespawnTimerCompleted'],
  [SSE_EVENTS.RESPAWN_ERROR, '_onRespawnError'],
  [SSE_EVENTS.RESPAWN_ACTION_LOG, '_onRespawnActionLog'],

  // Tasks
  [SSE_EVENTS.TASK_CREATED, '_onTaskCreated'],
  [SSE_EVENTS.TASK_COMPLETED, '_onTaskCompleted'],
  [SSE_EVENTS.TASK_FAILED, '_onTaskFailed'],
  [SSE_EVENTS.TASK_UPDATED, '_onTaskUpdated'],

  // Mux (tmux)
  [SSE_EVENTS.MUX_CREATED, '_onMuxCreated'],
  [SSE_EVENTS.MUX_KILLED, '_onMuxKilled'],
  [SSE_EVENTS.MUX_DIED, '_onMuxDied'],
  [SSE_EVENTS.MUX_STATS_UPDATED, '_onMuxStatsUpdated'],

  // Remote auto-reconnect (COD-108)
  [SSE_EVENTS.REMOTE_SESSION_RECONNECTED, '_onRemoteSessionReconnected'],
  [SSE_EVENTS.REMOTE_RECONNECT_EXHAUSTED, '_onRemoteReconnectExhausted'],

  // Ralph
  [SSE_EVENTS.SESSION_RALPH_LOOP_UPDATE, '_onRalphLoopUpdate'],
  [SSE_EVENTS.SESSION_RALPH_TODO_UPDATE, '_onRalphTodoUpdate'],
  [SSE_EVENTS.SESSION_RALPH_COMPLETION_DETECTED, '_onRalphCompletionDetected'],
  [SSE_EVENTS.SESSION_RALPH_STATUS_UPDATE, '_onRalphStatusUpdate'],
  [SSE_EVENTS.SESSION_CIRCUIT_BREAKER_UPDATE, '_onCircuitBreakerUpdate'],
  [SSE_EVENTS.SESSION_EXIT_GATE_MET, '_onExitGateMet'],

  // Bash tools
  [SSE_EVENTS.SESSION_BASH_TOOL_START, '_onBashToolStart'],
  [SSE_EVENTS.SESSION_BASH_TOOL_END, '_onBashToolEnd'],
  [SSE_EVENTS.SESSION_BASH_TOOLS_UPDATE, '_onBashToolsUpdate'],

  // Hooks (Claude Code hook events)
  [SSE_EVENTS.HOOK_IDLE_PROMPT, '_onHookIdlePrompt'],
  [SSE_EVENTS.HOOK_PERMISSION_PROMPT, '_onHookPermissionPrompt'],
  [SSE_EVENTS.HOOK_ELICITATION_DIALOG, '_onHookElicitationDialog'],
  [SSE_EVENTS.HOOK_STOP, '_onHookStop'],
  [SSE_EVENTS.HOOK_TEAMMATE_IDLE, '_onHookTeammateIdle'],
  [SSE_EVENTS.HOOK_TASK_COMPLETED, '_onHookTaskCompleted'],

  // Subagents (Claude Code background agents)
  [SSE_EVENTS.SUBAGENT_DISCOVERED, '_onSubagentDiscovered'],
  [SSE_EVENTS.SUBAGENT_UPDATED, '_onSubagentUpdated'],
  [SSE_EVENTS.SUBAGENT_TOOL_CALL, '_onSubagentToolCall'],
  [SSE_EVENTS.SUBAGENT_PROGRESS, '_onSubagentProgress'],
  [SSE_EVENTS.SUBAGENT_MESSAGE, '_onSubagentMessage'],
  [SSE_EVENTS.SUBAGENT_TOOL_RESULT, '_onSubagentToolResult'],
  [SSE_EVENTS.SUBAGENT_COMPLETED, '_onSubagentCompleted'],

  // Workflow runs (ultracode)
  [SSE_EVENTS.WORKFLOW_RUN_DISCOVERED, '_onWorkflowRunDiscovered'],
  [SSE_EVENTS.WORKFLOW_RUN_UPDATED, '_onWorkflowRunUpdated'],
  [SSE_EVENTS.WORKFLOW_RUN_REMOVED, '_onWorkflowRunRemoved'],

  // Images
  [SSE_EVENTS.IMAGE_DETECTED, '_onImageDetected'],
  [SSE_EVENTS.ATTACHMENT_DETECTED, '_onAttachmentDetected'],

  // Tunnel
  [SSE_EVENTS.TUNNEL_STARTED, '_onTunnelStarted'],
  [SSE_EVENTS.TUNNEL_STOPPED, '_onTunnelStopped'],
  [SSE_EVENTS.TUNNEL_PROGRESS, '_onTunnelProgress'],
  [SSE_EVENTS.TUNNEL_ERROR, '_onTunnelError'],
  [SSE_EVENTS.TUNNEL_QR_ROTATED, '_onTunnelQrRotated'],
  [SSE_EVENTS.TUNNEL_QR_REGENERATED, '_onTunnelQrRegenerated'],
  [SSE_EVENTS.TUNNEL_QR_AUTH_USED, '_onTunnelQrAuthUsed'],

  // Plan orchestration
  [SSE_EVENTS.PLAN_SUBAGENT, '_onPlanSubagent'],
  [SSE_EVENTS.PLAN_PROGRESS, '_onPlanProgress'],
  [SSE_EVENTS.PLAN_STARTED, '_onPlanStarted'],
  [SSE_EVENTS.PLAN_CANCELLED, '_onPlanCancelled'],
  [SSE_EVENTS.PLAN_COMPLETED, '_onPlanCompleted'],

  // Orchestrator loop
  [SSE_EVENTS.ORCHESTRATOR_STATE_CHANGED, '_onOrchestratorStateChanged'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_PROGRESS, '_onOrchestratorPlanProgress'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_READY, '_onOrchestratorPlanReady'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_STARTED, '_onOrchestratorPhaseStarted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_COMPLETED, '_onOrchestratorPhaseCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_FAILED, '_onOrchestratorPhaseFailed'],
  [SSE_EVENTS.ORCHESTRATOR_VERIFICATION, '_onOrchestratorVerification'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_ASSIGNED, '_onOrchestratorTaskAssigned'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_COMPLETED, '_onOrchestratorTaskCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_FAILED, '_onOrchestratorTaskFailed'],
  [SSE_EVENTS.ORCHESTRATOR_COMPLETED, '_onOrchestratorCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_ERROR, '_onOrchestratorError'],

  // Clipboard
  [SSE_EVENTS.CLIPBOARD_WRITE, '_onClipboardWrite'],

  // Session order (global tab order sync, COD-131)
  [SSE_EVENTS.SESSION_ORDER_CHANGED, '_onSessionOrderChanged'],

  // Web tabs (dashboard URLs)
  [SSE_EVENTS.WEBVIEW_CHANGED, '_onWebviewChanged'],
];


// ═══════════════════════════════════════════════════════════════
// Session Name Prefix Parser
// ═══════════════════════════════════════════════════════════════
// Parses w<N>-<caseName> or s<N>-<caseName> prefix from session names.
// Returns { prefix, suffix } or null if name does not match the pattern.
function parseSessionPrefix(name) {
  if (!name) return null;
  const m = name.match(/^(w\d+-[a-zA-Z0-9_-]+|s\d+-[a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const prefix = m[1];
  const rest = name.slice(prefix.length);
  if (rest === "") return { prefix, suffix: "" };
  if (rest.startsWith(": ")) return { prefix, suffix: rest.slice(2) };
  return null;
}

const DEFAULT_SHORTCUTS = [
  {
    id: 'show-shortcuts',
    group: 'Panels',
    label: 'Show Shortcuts',
    bindings: [
      { modifiers: ['ctrl'], key: '?', code: 'Slash' },
      { modifiers: ['alt'], key: '?', code: 'Slash' },
    ],
    action: 'showShortcutOverlay',
  },
  {
    id: 'close-session',
    group: 'Session',
    label: 'Close Session',
    bindings: [{ modifiers: ['ctrl'], key: 'w' }],
    action: 'killActiveSession',
  },
  {
    id: 'next-session',
    group: 'Session',
    label: 'Next Session',
    bindings: [{ modifiers: ['ctrl'], key: 'Tab' }],
    action: 'nextSession',
  },
  {
    id: 'clear-terminal',
    group: 'Terminal',
    label: 'Clear Terminal',
    bindings: [{ modifiers: ['ctrl'], key: 'l' }],
    action: 'clearTerminal',
  },
  {
    id: 'increase-font',
    group: 'Terminal',
    label: 'Increase Font',
    bindings: [
      { modifiers: ['ctrl'], key: '=', code: 'Equal' },
      { modifiers: ['ctrl'], key: '+', code: 'Equal' },
    ],
    action: 'increaseFontSize',
  },
  {
    id: 'decrease-font',
    group: 'Terminal',
    label: 'Decrease Font',
    bindings: [{ modifiers: ['ctrl'], key: '-', code: 'Minus' }],
    action: 'decreaseFontSize',
  },
  {
    id: 'voice-input',
    group: 'Terminal',
    label: 'Voice Input',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: 'V' }],
    action: 'toggleVoiceInput',
  },
  {
    id: 'move-tab-left',
    group: 'Tabs',
    label: 'Move Active Tab Left',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: '{', code: 'BracketLeft' }],
    action: 'moveActiveTabLeft',
  },
  {
    id: 'move-tab-right',
    group: 'Tabs',
    label: 'Move Active Tab Right',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: '}', code: 'BracketRight' }],
    action: 'moveActiveTabRight',
  },
  {
    id: 'command-palette',
    group: 'Session',
    label: 'Find Open Session',
    bindings: [
      { modifiers: ['ctrl'], key: 'k', code: 'KeyK' },
      { modifiers: ['meta'], key: 'k', code: 'KeyK' },
      { modifiers: ['alt'], key: 'k', code: 'KeyK' },
    ],
    action: 'openCommandPalette',
  },
  {
    id: 'previous-next-session',
    group: 'Session',
    label: 'Previous / Next Session',
    displayBindings: ['Alt/Option+[', 'Alt/Option+]'],
  },
  {
    id: 'switch-tab-n',
    group: 'Session',
    label: 'Switch to Tab N',
    displayBindings: ['Alt/Option+1-9'],
  },
  {
    id: 'focus-tabs',
    group: 'Tabs',
    label: 'Focus Tabs',
    displayBindings: ['ArrowLeft', 'ArrowRight', 'Home', 'End'],
  },
  {
    id: 'activate-focused-tab',
    group: 'Tabs',
    label: 'Activate Focused Tab',
    displayBindings: ['Enter', 'Space'],
  },
  {
    id: 'insert-newline',
    group: 'Terminal',
    label: 'Insert Newline',
    displayBindings: ['Shift+Enter', 'Ctrl+Enter'],
  },
  {
    id: 'close-panels',
    group: 'Panels',
    label: 'Close Panels',
    displayBindings: ['Escape'],
  },
  {
    id: 'rename-tab',
    group: 'Session',
    label: 'Rename Tab',
    bindings: [{ modifiers: [], key: 'F2', code: 'F2' }],
    action: 'renameActiveTab',
  },
];

// ═══════════════════════════════════════════════════════════════
// CodemanApp Class — constructor and global state
// ═══════════════════════════════════════════════════════════════

class CodemanApp {
  constructor() {
    this.sessions = new Map();
    this._shortIdCache = new Map(); // Cache session ID .slice(0, 8) results
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    // Stable per-page client ID — lets the server target this connection
    // for live filter updates (POST /api/events/subscribe) without forcing
    // an SSE reconnect on session switches.
    this._clientId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Per-TAB nonce for the WS registry key (COD-137). _loadReliableState()
    // later replaces _clientId with the browser-wide localStorage identity
    // (shared by every tab/window of this profile), so the WS upgrade sends
    // `clientId:nonce` instead — a same-tab reconnect still supersedes its own
    // socket, but two tabs on one session coexist instead of evicting each
    // other in a 4010 ping-pong. Input frames keep the bare clientId for seq
    // dedup.
    this._wsTabNonce = this._clientId;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this._responseViewerMarkdown = '';

    // ── Session detach / undock (beta) ───────────────────────────────────
    // A "solo window" is a popped-out browser window showing exactly one
    // session. Detected from the /session/:id URL path (robust even if a cached
    // service-worker shell loads), with the server-injected global as a fallback.
    this.soloSessionId = this._detectSoloSessionId();
    this.isSoloWindow = !!this.soloSessionId;
    this.detachedSessions = new Set();   // dashboard-side: ids currently popped out
    this.detachedWindows = new Map();    // dashboard-side: id -> WindowProxy
    this._detachWatchTimers = new Map(); // dashboard-side: id -> setInterval handle
    this.windowChannel = null;           // BroadcastChannel for cross-window sync
    this._redockGrace = new Map();       // id -> timer: deferred redock (debounces popup reloads)
    this._detachPingPending = null;      // Set of ids awaiting a liveness answer
    this._detachLivenessTimer = null;    // periodic reconcile of channel-only detached windows
    this._detachOrphanStrikes = new Map(); // id -> consecutive unanswered roll-calls (redock at 2)

    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._initFallbackTimer = null; // fallback timer if SSE init doesn't arrive
    this._selectGeneration = 0;   // cancel stale selectSession loads
    this._initialFullBufferLoad = true; // first buffer load after a page load fetches full tmux scrollback (COD-47)
    this.terminalLoadStates = new Map(); // Map<sessionId, { generation, phase }>
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this._sessionsLoadedSincePageOpen = new Set(); // First load after browser reload gets full tmux scrollback
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.muxSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;

    // Ultracode / Workflow run visualization (master-detail tab)
    this.workflowRuns = new Map(); // runId -> run summary (LEFT list)
    this.workflowRunDetails = new Map(); // runId -> full run with agents[] (RIGHT pane)
    this.activeWorkflowRunId = null;
    this.activeWorkflowPhaseIndex = null;
    // Ultracode floating run windows (additional to the dock panel — ultracode-windows.js)
    this.ultracodeWindows = new Map(); // runId -> { element, parentSessionId, dragListeners, collapsed }
    this.ultracodeWindowsClosed = new Set(); // runIds the user explicitly dismissed (don't re-pop)
    this.ultracodeWindowCloseTimers = new Map(); // runId -> auto-close timeout
    this.ultracodeWindowZIndex = 1000;
    this.subagentWindows = new Map(); // Map<agentId, { element, position }>
    this.subagentWindowZIndex = ZINDEX_SUBAGENT_BASE;
    this.minimizedSubagents = new Map(); // Map<sessionId, Set<agentId>> - minimized to tab
    this._subagentHideTimeout = null; // Timeout for hover-based dropdown hide

    // PERSISTENT parent associations - agentId -> sessionId
    // This is the SINGLE SOURCE OF TRUTH for which tab an agent window connects to.
    // Once set, never recalculated. Persisted to localStorage and server.
    this.subagentParentMap = new Map();

    // Agent Teams tracking
    this.teams = new Map(); // Map<teamName, TeamConfig>
    this.teamTasks = new Map(); // Map<teamName, TeamTask[]>
    this.teammateMap = new Map(); // Map<agentId-prefix, {name, color, teamName}> for quick lookup

    // Teammate tmux pane terminals (Agent Teams feature)
    this.teammatePanesByName = new Map(); // Map<name, { paneTarget, sessionId, color }>
    this.teammateTerminals = new Map(); // Map<agentId, { terminal, fitAddon, paneTarget, sessionId, resizeObserver }>

    this.terminalBufferCache = new Map(); // Map<sessionId, string> — client-side cache for instant tab re-visits (max 20)

    this.ralphStatePanelCollapsed = true; // Default to collapsed
    this.ralphClosedSessions = new Set(); // Sessions where user explicitly closed Ralph panel

    // Plan subagent windows (visible agents during plan generation)
    this.planSubagents = new Map(); // Map<agentId, { type, model, status, startTime, element, relativePos }>
    this.planSubagentWindowZIndex = ZINDEX_PLAN_SUBAGENT_BASE;
    this.planGenerationStopped = false; // Flag to ignore SSE events after Stop
    this.planAgentsMinimized = false; // Whether agent windows are minimized to tab

    // Wizard dragging state
    this.wizardDragState = null; // { startX, startY, startLeft, startTop, isDragging }
    this.wizardDragListeners = null; // { move, up } for cleanup
    this.wizardPosition = null; // { left, top } - null means centered

    // Project Insights tracking (active Bash tools with clickable file paths)
    this.projectInsights = new Map(); // Map<sessionId, ActiveBashTool[]>
    this.logViewerWindows = new Map(); // Map<windowId, { element, eventSource, filePath }>
    this.logViewerWindowZIndex = ZINDEX_LOG_VIEWER_BASE;
    this.projectInsightsPanelVisible = false;

    // Orchestrator loop state
    this.orchestratorState = null; // { state, plan, currentPhaseIndex, stats }
    this.orchestratorPanelVisible = false;
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;
    this.attachmentCards = new Map(); // Map<attachmentId, { element, sessionId, filePath }>
    this.attachmentCardStack = null;
    this.attachmentHistoryCounts = new Map(); // Map<sessionId, count>
    this.attachmentHistoryItems = [];
    this.attachmentHistoryDrawerOpen = false;
    this.filePreviewZoom = 1;

    // File browser state (methods in panels-ui.js)
    this.fileBrowserData = null;
    this.fileBrowserSessionId = null;
    this.fileBrowserLoadGeneration = 0;
    this.fileBrowserExpandedDirs = new Set();
    this.fileBrowserLoadedDirs = new Set();
    this.fileBrowserFilter = '';
    this.fileBrowserAllExpanded = false;
    this.fileBrowserDragListeners = null;
    this.filePreviewContent = '';

    // Toast container cache (methods in panels-ui.js)
    this._toastContainer = null;

    // Tunnel indicator state
    this._tunnelUrl = null;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // WebSocket terminal I/O (low-latency bypass of HTTP POST + SSE)
    this._ws = null;            // WebSocket instance for active session
    this._wsSessionId = null;   // Session ID the WS is connected to
    this._wsReady = false;      // True when WS is open and ready for I/O
    this._wsState = 'disconnected'; // connecting | connected | reconnecting | fallback | disconnected
    this._wsLastClose = null; // { code, reason, at } for transport diagnostics
    this._wsLastRecvAt = 0;     // ms timestamp of the last frame received on the active WS
    this._wsCloseRefreshTimer = null;
    this._wsInputSendCount = 0;
    this._httpFallbackSendCount = 0;

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks
    this._isLoadingBuffer = false; // true during chunkedTerminalWrite — blocks live SSE writes
    this._loadBufferQueue = null;  // queued SSE events during buffer load
    this._bufferLoadSeq = 0;
    this._bufferLoadOwner = null;

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debounce timers (managed by _debouncedCall)
    this._debounceTimers = Object.create(null);

    // System stats polling
    this.systemStatsInterval = null;

    // SSE reconnect timeout (to prevent orphaned timeouts)
    this.sseReconnectTimeout = null;

    // SSE event listener cleanup function (to prevent listener accumulation on reconnect)
    this._sseListenerCleanup = null;

    // SSE connection status tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isOnline = navigator.onLine;

    // Reliable, durable input delivery (replaces the old best-effort queue).
    // Every input byte is recorded with a stable clientId + a monotonic
    // per-session seq, persisted to localStorage, and only dropped once the
    // server ACKs that exact seq — so a half-open socket silently dropping a
    // frame, a reconnect, or a page reload can never lose a typed prompt.
    // Exactly-once: the server applies each (clientId, seq) at most once.
    this._connectionStatus = 'connected';
    this._clientId = '';
    this._seqCounters = new Map(); // sessionId -> last issued seq
    this._pendingDeliveries = new Map(); // sessionId -> [{seq,data,useMux,ts,tries,sentAt}]
    // Last rendered connection-indicator tuple; the hot input path skips DOM
    // writes when the freshly computed descriptor is identical (COD-136).
    this._lastIndicatorDescriptor = null;
    this._postDraining = new Set(); // sessionIds with an in-flight POST drainer
    this._persistReliableTimer = null;
    this._reliableAckTimeoutMs = 4000; // unacked WS frame older than this ⇒ socket likely dead
    this._reliableMaxBytes = 256 * 1024; // cap on the persisted backlog
    this._loadReliableState();
    this._reliableSweepTimer = setInterval(() => this._redeliverSweep(), 2000);
    // Flush the durable queue synchronously when the page is hidden/closed —
    // debounced persistence may have a pending write we mustn't lose on reload.
    window.addEventListener('pagehide', () => this._persistReliableNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._persistReliableNow();
    });

    // Local echo overlay — DOM overlay positioned at the visible ❯ prompt
    // (not at buffer.cursorY, which reflects Ink's internal cursor position)
    this._localEchoOverlay = null;  // created after terminal.open()
    this._localEchoEnabled = false; // true when setting on + session active
    this._restoringFlushedState = false; // true during selectSession buffer load — protects flushed Maps

    // Accessibility: Focus trap for modals
    this.activeFocusTrap = null;

    // Notification system
    this.notificationManager = new NotificationManager(this);
    this.idleTimers = new Map(); // Map<sessionId, timeout> for stuck detection
    this._foreignResizeTimer = null; // COD-179 debounce for reconcile-after-foreign-resize
    this._foreignResizeDirty = null; // sessionId dirtied by a foreign resize mid-turn (final reconcile on idle)
    this._lastReconcileWrite = null; // {id, buf} of the last reconcile rewrite — unchanged capture = no-op tick
    // COD-180: heal busy remote TUI tabs on a cadence (all guards live in the tick)
    this._remoteReconcileInterval = setInterval(() => this._remoteReconcileTick(), REMOTE_RECONCILE_TICK_MS);
    // ── COD-187 live mirror ──
    // Codex/gemini tabs render only the current screen (scrollback 0); scroll-up
    // opens a frozen history view fed from the canonical tmux capture.
    this._viewMode = 'live'; // 'live' | 'history' — meaningful only for mirror sessions
    this._historyLoadGen = 0; // aborts stale history fetches
    this._historyMissedOutput = false; // live output arrived while frozen in history
    this._lastMirrorFrame = null; // {id, buf} dedupe for _refreshMirrorFrame
    this._historyExitAt = 0; // history re-entry cooldown timestamp
    this._historyPartial = false; // COD-187 lazy load: history view holds only the last N lines
    this._historyPrefetch = null; // COD-190 speculative prefetch {id, at, promise}
    this._historyExpandInFlight = false;
    this._historyEntryAccum = 0; // wheel-up accumulation toward history entry
    this._historyEntryAccumAt = 0;
    // Cached setting flag (hot path) — read storage directly: the settings-ui
    // mixin may not be attached yet at construct time. Default ON.
    let liveMirror = true;
    try {
      const lmKey =
        typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'mobile'
          ? 'codeman-app-settings-mobile'
          : 'codeman-app-settings';
      liveMirror = JSON.parse(localStorage.getItem(lmKey) || '{}').liveMirrorEnabled !== false;
    } catch {
      /* default ON */
    }
    this._liveMirrorEnabled = liveMirror;

    // DOM element cache for performance (avoid repeated getElementById calls)
    this._elemCache = {};

    this.init();
  }

  // Cached element getter - avoids repeated DOM queries
  $(id) {
    if (!this._elemCache[id]) {
      this._elemCache[id] = document.getElementById(id);
    }
    return this._elemCache[id];
  }

  // Clear a named timeout property: if (this[name]) { clearTimeout(this[name]); this[name] = null; }
  _clearTimer(timerName) {
    if (this[timerName]) {
      clearTimeout(this[timerName]);
      this[timerName] = null;
    }
  }

  // Check if a selectSession generation is stale (a newer tab switch has started).
  // If stale, cleans up buffer-loading state and returns true.
  _isStaleSelect(selectGen) {
    if (selectGen !== this._selectGeneration) {
      if (this._isLoadingBuffer) this._finishBufferLoad(selectGen);
      this._restoringFlushedState = false;
      return true;
    }
    return false;
  }

  // Format token count: 1000k -> 1m, 1450k -> 1.45m, 500 -> 500
  formatTokens(count) {
    if (count >= 1000000) {
      const m = count / 1000000;
      return m >= 10 ? `${m.toFixed(1)}m` : `${m.toFixed(2)}m`;
    } else if (count >= 1000) {
      const k = count / 1000;
      return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
    }
    return String(count);
  }

  // Estimate cost from tokens using Claude Opus pricing
  // Input: $15/M tokens, Output: $75/M tokens
  estimateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // ═══════════════════════════════════════════════════════════════
  // Pending Hooks State Machine
  // ═══════════════════════════════════════════════════════════════
  // Track pending hook events per session to determine tab alerts.
  // Action hooks (permission_prompt, elicitation_dialog) take priority over idle_prompt.

  setPendingHook(sessionId, hookType) {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, new Set());
    }
    this.pendingHooks.get(sessionId).add(hookType);
    this.updateTabAlertFromHooks(sessionId);
  }

  clearPendingHooks(sessionId, hookType = null) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks) return;
    if (hookType) {
      hooks.delete(hookType);
    } else {
      hooks.clear();
    }
    if (hooks.size === 0) {
      this.pendingHooks.delete(sessionId);
    }
    this.updateTabAlertFromHooks(sessionId);
  }

  updateTabAlertFromHooks(sessionId) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks || hooks.size === 0) {
      this.tabAlerts.delete(sessionId);
    } else if (hooks.has('permission_prompt') || hooks.has('elicitation_dialog')) {
      this.tabAlerts.set(sessionId, 'action');
    } else if (hooks.has('idle_prompt')) {
      this.tabAlerts.set(sessionId, 'idle');
    }
    this.renderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Init — app bootstrap and mobile setup
  // ═══════════════════════════════════════════════════════════════

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Detach/undock: open the cross-window sync channel; if this is a solo
    // (popped-out) window, apply its minimal chrome immediately so the tab
    // strip never flashes before handleInit selects the target session.
    this._initWindowChannel();
    if (this.isSoloWindow) document.body.classList.add('solo-mode');
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    VoiceInput.init();
    KeyboardAccessoryBar.init();
    // Apply keyboard bar mode from settings
    const _kbSettings = this.loadAppSettingsFromStorage();
    if (_kbSettings.extendedKeyboardBar) KeyboardAccessoryBar.setMode('extended');
    this.applyHeaderVisibilitySettings();
    this.restorePlanUsageChip();
    this.applySkin();
    this.applyLocalization();
    this.applyTabWrapSettings();
    this.applyMonitorVisibility();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    // Defer heavy terminal canvas creation to next frame — lets browser paint header/skeleton first.
    // IMPORTANT: connectSSE must run AFTER initTerminal to prevent a race where SSE data
    // arrives before the terminal exists, orphaning data in pendingWrites and corrupting
    // escape sequence boundaries when later concatenated with fresh data.
    requestAnimationFrame(() => {
      this.initTerminal();
      this.loadFontSize();
      this.connectSSE();
      // Only fetch state if SSE init event hasn't arrived within 3s (avoids duplicate handleInit)
      this._initFallbackTimer = setTimeout(() => {
        if (this._initGeneration === 0) this.loadState();
      }, 3000);
    });
    // Register service worker for push notifications
    this.registerServiceWorker();
    // Fetch tunnel status for header indicator (desktop only)
    this.loadTunnelStatus();
    // Share a single settings fetch between both consumers
    const settingsPromise = fetch('/api/settings').then(r => r.ok ? r.json() : null).then(env => env?.data ?? null).catch(() => null);
    this.loadQuickStartCases(null, settingsPromise);
    this._initRunMode();
    this.initWebviews?.();
    this.setupEventListeners();
    // Mobile: ensure button taps register even when keyboard is visible.
    // On mobile, tapping a button while the soft keyboard is up causes the
    // browser to dismiss the keyboard first (blur event), swallowing the tap.
    // The button only receives the click on a second tap. Fix: intercept
    // touchstart on buttons while keyboard is visible, preventDefault to stop
    // the dismiss-swallows-tap behavior, and trigger the click programmatically.
    if (MobileDetection.isTouchDevice()) {
      const addKeyboardTapFix = (container) => {
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
          if (!KeyboardHandler.keyboardVisible) return;
          const btn = e.target.closest('button');
          if (!btn) return;
          e.preventDefault();
          btn.click();
          // Refocus terminal so keyboard stays open (e.g. voice input button)
          if (typeof app !== 'undefined' && app.terminal) {
            app.terminal.focus();
          }
        }, { passive: false });
      };
      addKeyboardTapFix(document.querySelector('.toolbar'));
      addKeyboardTapFix(document.querySelector('.welcome-overlay'));
    }
    // System stats polling deferred until sessions exist (started in handleInit/session:created)
    // Setup online/offline detection
    this.setupOnlineDetection();
    // Load server-stored settings (async, re-applies visibility after load)
    this._settingsSyncPromise = this.loadAppSettingsFromServer(settingsPromise).catch(() => {});
    this._settingsSyncPromise.then(() => {
      this.applyHeaderVisibilitySettings();
      this.applySkin();
      this.applyLocalization();
      this.applyTabWrapSettings();
      this.applyMonitorVisibility();
      // ultracodeFloatingWindows syncs from the server (non-display key), but on a
      // FRESH device the getLightState run snapshot can seed workflowRuns BEFORE this
      // async settings load resolves — so the floating-window gate read false then and
      // skipped any already-active run. Re-sync now that the real setting is loaded so
      // an in-flight run pops its window immediately instead of waiting for the next
      // ~10s SSE tick. Idempotent: open windows are left as-is; if the setting is off
      // it tears any premature windows down.
      if (typeof this.syncAllUltracodeFloatingWindows === 'function') {
        this.syncAllUltracodeFloatingWindows();
      }
    });
    // Hide loading skeleton now that the app shell is ready
    document.body.classList.add('app-loaded');
  }

  _initWebGL() {
    if (typeof WebglAddon === 'undefined') return;
    try {
      this._webglAddon = new WebglAddon.WebglAddon();
      this._webglAddon.onContextLoss(() => {
        console.error('[CRASH-DIAG] WebGL context LOST — falling back to canvas renderer');
        _crashDiag.log('WEBGL_LOST');
        this._disableWebGLSticky('context-lost');
        this._disposeWebGLObserver();
        this._webglAddon?.dispose();
        this._webglAddon = null;
        this._scheduleTerminalRepaint();
      });
      this.terminal.loadAddon(this._webglAddon);
      console.log('[CRASH-DIAG] WebGL renderer enabled');
      this._installWebGLLongTaskGuard();
    } catch (_e) { /* WebGL2 unavailable — canvas renderer used */ }
  }

  /**
   * Watch for sustained main-thread stalls that indicate WebGL/GPU trouble.
   * After WEBGL_FALLBACK.LONGTASK_COUNT long tasks (>=LONGTASK_MS each) within
   * WINDOW_MS, dispose the WebGL addon and persist a sticky disable so
   * subsequent reloads also use the DOM renderer. GRACE_MS skips initial-load
   * stalls. Force-re-enable: ?webgl=force.
   */
  _installWebGLLongTaskGuard() {
    if (typeof PerformanceObserver === 'undefined' || this._webglLongTaskObserver) return;
    const installedAt = performance.now();
    const recent = [];
    try {
      this._webglLongTaskObserver = new PerformanceObserver((list) => {
        if (!this._webglAddon) return;
        const now = performance.now();
        if (now - installedAt < WEBGL_FALLBACK.GRACE_MS) return;
        if (evaluateWebGLLongTaskTrip(recent, list.getEntries(), now)) {
          console.warn(`[CRASH-DIAG] WebGL long-task threshold (${recent.length} stalls/${WEBGL_FALLBACK.WINDOW_MS}ms) — falling back to canvas renderer`);
          _crashDiag.log(`WEBGL_FALLBACK: ${recent.length}`);
          this._disableWebGLSticky('long-tasks');
          this._disposeWebGLObserver();
          this._webglAddon?.dispose();
          this._webglAddon = null;
          this._scheduleTerminalRepaint();
        }
      });
      this._webglLongTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch { /* longtask not supported */ }
  }

  /**
   * Disconnect the WebGL longtask observer. Idempotent. Called from the trip
   * path, the onContextLoss handler, and any future terminal-teardown path —
   * the observer outlives its addon otherwise, holding a closure reference
   * over `this` for every long task the page emits.
   */
  _disposeWebGLObserver() {
    if (!this._webglLongTaskObserver) return;
    try { this._webglLongTaskObserver.disconnect(); } catch {}
    this._webglLongTaskObserver = null;
  }

  /**
   * Repaint the full terminal viewport after a renderer swap (WebGL → canvas/DOM).
   * Scheduled on the next frame so it lands after the addon teardown settles, and
   * debounced so the context-loss and long-task fallback paths can't double-fire.
   * No-ops safely if the terminal isn't ready.
   */
  _scheduleTerminalRepaint() {
    if (this._terminalRepaintScheduled) return;
    this._terminalRepaintScheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    raf(() => {
      this._terminalRepaintScheduled = false;
      try { this.terminal?.refresh(0, this.terminal.rows - 1); } catch {}
    });
  }

  _disableWebGLSticky(reason) {
    try {
      localStorage.setItem('codeman-webgl-disabled', JSON.stringify({ reason, at: Date.now() }));
    } catch {}
  }

  getShortcutRegistry() {
    const settings = this.loadAppSettingsFromStorage?.() || {};
    const shortcutOverrides = settings.shortcutOverrides || {};
    return this.getDefaultShortcutRegistry().map((shortcut) => {
      const override = shortcutOverrides[shortcut.id];
      if (!override || typeof override !== 'object') return shortcut;
      const next = { ...shortcut };
      if (typeof override.disabled === 'boolean') next.disabled = override.disabled;
      if (Array.isArray(override.bindings)) {
        next.bindings = this.normalizeShortcutBindings(override.bindings);
        delete next.displayBindings;
      }
      return next;
    });
  }

  getDefaultShortcutRegistry() {
    return DEFAULT_SHORTCUTS.map((shortcut) => ({
      ...shortcut,
      bindings: shortcut.bindings ? shortcut.bindings.map((binding) => ({ ...binding, modifiers: [...(binding.modifiers || [])] })) : undefined,
      displayBindings: shortcut.displayBindings ? [...shortcut.displayBindings] : undefined,
    }));
  }

  normalizeShortcutBindings(bindings) {
    return bindings
      .filter((binding) => binding && typeof binding === 'object')
      .map((binding) => ({
        key: typeof binding.key === 'string' ? binding.key : '',
        code: typeof binding.code === 'string' ? binding.code : undefined,
        modifiers: Array.isArray(binding.modifiers)
          ? binding.modifiers.filter((modifier) => ['ctrl', 'meta', 'alt', 'shift'].includes(modifier))
          : [],
      }))
      .filter((binding) => binding.key || binding.code);
  }

  matchesShortcutEvent(e, shortcut) {
    if (!shortcut || shortcut.disabled || !Array.isArray(shortcut.bindings)) return false;
    return shortcut.bindings.some((binding) => {
      const modifiers = binding.modifiers || [];
      const wantsPrimary = modifiers.includes('ctrl') || modifiers.includes('meta');
      if (wantsPrimary !== !!(e.ctrlKey || e.metaKey)) return false;
      if (modifiers.includes('shift') !== !!e.shiftKey) return false;
      if (modifiers.includes('alt') !== !!e.altKey) return false;
      if (binding.code && e.code === binding.code) return true;
      return !!(
        binding.key &&
        typeof e.key === 'string' &&
        e.key.toLowerCase() === String(binding.key).toLowerCase()
      );
    });
  }

  shortcutEventKey(e) {
    const shiftedCodeKeys = {
      Slash: '?',
      Equal: '+',
      BracketLeft: '{',
      BracketRight: '}',
    };
    if (e.shiftKey && shiftedCodeKeys[e.code]) return shiftedCodeKeys[e.code];
    return e.key || '';
  }

  runShortcutAction(shortcut) {
    if (!shortcut?.action) return false;
    if (shortcut.action === 'toggleVoiceInput') {
      VoiceInput.toggle();
      return true;
    }
    const fn = this[shortcut.action];
    if (typeof fn !== 'function') return false;
    fn.call(this);
    return true;
  }

  formatShortcutBinding(binding) {
    if (typeof binding === 'string') return binding;
    const parts = [];
    const modifiers = binding.modifiers || [];
    if (modifiers.includes('ctrl')) parts.push('Ctrl');
    if (modifiers.includes('meta')) parts.push('Cmd');
    if (modifiers.includes('alt')) parts.push('Alt/Option');
    if (modifiers.includes('shift')) parts.push('Shift');
    const key = binding.key || binding.code || '';
    parts.push(key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key);
    return parts.filter(Boolean).join('+');
  }

  renderShortcutOverlay() {
    const list = document.getElementById('shortcutOverlayList');
    if (!list) return;
    const groups = {};
    for (const shortcut of this.getShortcutRegistry()) {
      if (shortcut.disabled) continue;
      const group = shortcut.group || 'General';
      if (!groups[group]) groups[group] = [];
      groups[group].push(shortcut);
    }
    const formatBindings = (shortcut) => {
      const bindings = shortcut.displayBindings || shortcut.bindings || [];
      return bindings
        .map((binding) => `<kbd>${escapeHtml(this.formatShortcutBinding(binding))}</kbd>`)
        .join(' / ');
    };
    list.innerHTML = Object.entries(groups)
      .map(
        ([group, shortcuts]) =>
          `<div class="shortcut-overlay-group"><div class="shortcut-overlay-group-label">${escapeHtml(group)}</div>` +
          shortcuts
            .map(
              (shortcut) =>
                `<div class="shortcut-overlay-row"><span class="shortcut-overlay-label">${escapeHtml(shortcut.label)}</span><span class="shortcut-overlay-keys">${formatBindings(shortcut)}</span></div>`
            )
            .join('') +
          '</div>'
      )
      .join('');
  }

  showShortcutOverlay() {
    const modal = document.getElementById('shortcutOverlayModal');
    if (!modal) return;
    this.renderShortcutOverlay();
    modal.classList.add('active');
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeShortcutOverlay() {
    const modal = document.getElementById('shortcutOverlayModal');
    if (modal) modal.classList.remove('active');
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Event Listeners (Keyboard Shortcuts, Resize, Beforeunload)
  // ═══════════════════════════════════════════════════════════════

  setupEventListeners() {
    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Don't intercept keys during CJK IME composition
      if (e.isComposing || e.keyCode === 229) return;
      if (this._capturingShortcutId || e.target?.classList?.contains('shortcut-binding-input')) return;

      if (this.shouldOpenCommandPaletteFromShortcut?.(e)) {
        e.preventDefault();
        this.openCommandPalette();
        return;
      }

      if (this.shouldOpenCommandPaletteFromShortcut?.(e)) {
        e.preventDefault();
        this.openCommandPalette();
        return;
      }

      // Escape - close panels and modals (different logic: no preventDefault, no return)
      if (e.key === 'Escape') {
        // The View Response overlay is a top-level layer: close it first and
        // consume the key so ESC never reaches xterm/the CLI (where it has its own
        // cancel semantics), then restore terminal focus. Explicit close (not a
        // toggle) so a second Escape can't reopen it (COD-229).
        if (this._maybeCloseResponseViewerOnEscape(e)) return;
        this.closeAllPanels();
        this.closeHelp();
        this.closeShortcutOverlay();
        if (this.attachmentHistoryDrawerOpen) this.closeAttachmentHistory();
        this.closeSessionManager();
        this.closeCommandPalette?.();
      }

      // Option/Alt session navigation uses physical key CODES, not e.key, so macOS
      // keyboard layouts that emit special characters under Option (Option+1 -> ¡,
      // Option+[ -> "“") still switch sessions. e.code is the physical key regardless
      // of layout. Option+1-9 = switch by index; Option+[ / Option+] = prev / next.
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const code = e.code || '';
        const digitMatch = code.match(/^Digit([1-9])$/);
        if (digitMatch) {
          const idx = parseInt(digitMatch[1], 10) - 1;
          // Sessions occupy 1..N and web tabs continue from N+1, matching the
          // numbers actually painted on the tabs.
          if (idx < this.sessionOrder.length) {
            e.preventDefault();
            this.selectSession(this.sessionOrder[idx]);
          } else {
            const webIdx = idx - this.sessionOrder.length;
            const webId = (this.webviewOrder || [])[webIdx];
            if (webId) {
              e.preventDefault();
              this.openWebview(webId);
            }
          }
          return;
        }
        if (e.code === 'BracketLeft') {
          e.preventDefault();
          this.prevSession();
          return;
        }
        if (e.code === 'BracketRight') {
          e.preventDefault();
          this.nextSession();
          return;
        }
      }

      for (const shortcut of this.getShortcutRegistry()) {
        if (this.matchesShortcutEvent(e, shortcut)) {
          e.preventDefault();
          this.runShortcutAction(shortcut);
          return;
        }
      }
    }, true); // Use capture phase to handle before terminal

    // Token stats click handler (with guard to prevent duplicate handlers on reconnect)
    const tokenEl = this.$('headerTokens');
    if (tokenEl && !tokenEl._statsHandlerAttached) {
      tokenEl.classList.add('clickable');
      tokenEl._statsHandlerAttached = true;
      tokenEl.addEventListener('click', () => this.openTokenStats());
    }

    // Color picker for session customization
    this.setupColorPicker();

    window.addEventListener('resize', () => {
      clearTimeout(this._tabOverflowResizeTimer);
      this._tabOverflowResizeTimer = setTimeout(() => this.updateTabOverflowMode(), 80);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._scheduleTerminalRepaint();
    });

    window.addEventListener('focus', () => this._scheduleTerminalRepaint());
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Connection
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST a live subscription update so the server filters terminal events
   * to the given session(s) for this client. Fire-and-forget — failures
   * are non-fatal because we'll still get every event we don't want
   * (just at higher cost), and the next reconnect carries the filter via
   * the SSE query string.
   */
  _updateSseSubscription(sessionId) {
    try {
      const body = JSON.stringify({
        clientId: this._clientId,
        sessions: sessionId ? [sessionId] : null,
      });
      fetch('/api/events/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Session detach / undock (beta/session-detach)
  //
  // Each detached window is just another normal client of the same session:
  // the server already fans one PTY's output out to N SSE/WS clients and merges
  // input from all of them, so a popped-out window is live with no extra server
  // plumbing. The dashboard tracks which sessions are out, marks their tabs, and
  // re-docks when the window closes. A BroadcastChannel keeps state in sync
  // across windows (and survives a dashboard reload via roll-call).
  // ══════════════════════════════════════════════════════════════════════

  /** Resolve the solo session id from the URL path (preferred) or the
   *  server-injected global (fallback). Returns null for the normal dashboard. */
  _detectSoloSessionId() {
    try {
      if (typeof window !== 'undefined' && typeof window.__CODEMAN_SOLO__ === 'string' && window.__CODEMAN_SOLO__) {
        return window.__CODEMAN_SOLO__;
      }
      const m = location.pathname.match(/^\/session\/([^/]+)\/?$/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }

  /**
   * Pop a session out into its own browser window. SINGLE, idempotent entry
   * point: the tab's pop-out icon calls this, and a future gesture layer
   * ("pinch to drop") calls the exact same method — so keep it cheap and
   * side-effect-light. Calling it again for an already-open window just raises
   * that window.
   * @param {string} id session id
   */
  detachSession(id) {
    if (this.isSoloWindow) return;            // a solo window can't spawn more
    if (!this.sessions.has(id)) return;
    // Already detached → raise the existing popup instead of opening (or
    // reloading) another. Mirrors the tab-click path: after a dashboard reload
    // we hold no WindowProxy ref, so this raises via the channel rather than
    // re-running window.open (which would reload the popup's terminal). Returns
    // false only when we owned a now-closed window (re-dock + fall through to
    // genuinely re-open below).
    if (this.detachedSessions.has(id) && this._raiseDetached(id)) return;
    const features = 'width=960,height=680,menubar=no,toolbar=no,location=no,status=no';
    let win = null;
    try { win = window.open('/session/' + encodeURIComponent(id), 'codeman-session-' + id, features); } catch {}
    if (!win) {
      this.showToast?.('Pop-out blocked — allow popups for this site to detach a session', 'error');
      return;
    }
    this.detachedWindows.set(id, win);
    this._markDetached(id, true);
    this._watchDetachedWindow(id, win);
    this._postWindowMessage({ type: 'detached', id });
    try { win.focus(); } catch {}
  }

  /** Raise the popup for an already-detached session. Returns true if the raise
   *  was handled (caller should stop); false if we owned a now-closed window and
   *  re-docked it (caller should fall through to inline / re-open). Unifies the
   *  pop-out icon and tab-click paths so neither reloads a live popup. */
  _raiseDetached(id) {
    const win = this.detachedWindows.get(id);
    if (win && !win.closed) { try { win.focus(); } catch {} return true; }
    if (win && win.closed) { this._redock(id); return false; }   // owned ref dead → redock + fall through
    // No local ref (dashboard reloaded): assume alive and raise via the channel.
    // A liveness ping (or the popup's own unload) heals the badge if it's gone.
    this._postWindowMessage({ type: 'focus-request', id });
    return true;
  }

  /** Re-dock a session: close its window (which re-docks via its unload
   *  announcement) and clear dashboard state now. */
  redockSession(id) {
    const win = this.detachedWindows.get(id);
    if (win && !win.closed) { try { win.close(); } catch {} }
    this._postWindowMessage({ type: 'close-request', id });
    this._redock(id);
  }

  /** Clear all dashboard-side detached state/timers for a session. */
  _redock(id) {
    const t = this._detachWatchTimers.get(id);
    if (t) { clearInterval(t); this._detachWatchTimers.delete(id); }
    this._cancelPendingRedock(id);
    this._detachOrphanStrikes.delete(id);
    this.detachedWindows.delete(id);
    this._markDetached(id, false);
  }

  /** Defer a channel-driven redock briefly. A popup *reload* emits 'redocked'
   *  then re-announces 'detached'; the grace window lets that re-announce cancel
   *  the redock, so a reload doesn't blip the dashboard badge. A real close
   *  leaves the redock unanswered and it fires. */
  _scheduleRedock(id) {
    if (this._redockGrace.has(id)) return;
    const timer = setTimeout(() => { this._redockGrace.delete(id); this._redock(id); }, 1500);
    this._redockGrace.set(id, timer);
  }

  _cancelPendingRedock(id) {
    const t = this._redockGrace.get(id);
    if (t) { clearTimeout(t); this._redockGrace.delete(id); }
  }

  /** Toggle the "detached" marker on a tab (immediate DOM update + state set).
   *  Full re-renders re-apply the class from this.detachedSessions. */
  _markDetached(id, on) {
    if (on) this.detachedSessions.add(id); else this.detachedSessions.delete(id);
    const container = this.$('sessionTabs');
    const tab = container && container.querySelector(`.session-tab[data-id="${id}"]`);
    if (tab) tab.classList.toggle('detached', on);
  }

  /** Poll a window we opened; when it closes, re-dock its tab. This is the
   *  primary (reliable) close-detection path for windows this tab opened. */
  _watchDetachedWindow(id, win) {
    const prev = this._detachWatchTimers.get(id);
    if (prev) clearInterval(prev);
    const timer = setInterval(() => {
      if (!win || win.closed) {
        clearInterval(timer);
        this._detachWatchTimers.delete(id);
        this._redock(id);
      }
    }, 800);
    this._detachWatchTimers.set(id, timer);
  }

  /** Open the cross-window BroadcastChannel and wire role-specific handlers. */
  _initWindowChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try { this.windowChannel = new BroadcastChannel('codeman-windows'); }
    catch { this.windowChannel = null; return; }
    this.windowChannel.onmessage = (e) => this._onWindowMessage(e.data);
    if (this.isSoloWindow) {
      // Announce presence so the dashboard marks this session's tab detached —
      // even if this window was opened directly by URL rather than window.open.
      this._postWindowMessage({ type: 'detached', id: this.soloSessionId });
      // On close, tell the dashboard to re-dock. pagehide is the reliable signal
      // on modern browsers; beforeunload is a belt-and-suspenders fallback.
      const announceClose = () => this._postWindowMessage({ type: 'redocked', id: this.soloSessionId });
      window.addEventListener('pagehide', announceClose);
      window.addEventListener('beforeunload', announceClose);
    } else {
      // Dashboard: ask any already-open solo windows to re-announce themselves
      // (covers a dashboard reload while popups remain open), then keep
      // reconciling so a popup that died WITHOUT a 'redocked' (hard kill / crash)
      // eventually un-marks its tab.
      this._postWindowMessage({ type: 'roll-call' });
      this._startDetachLiveness();
    }
  }

  _postWindowMessage(msg) {
    try { if (this.windowChannel) this.windowChannel.postMessage(msg); } catch {}
  }

  _onWindowMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.isSoloWindow) {
      // Roll-call has no id (broadcast to all) — answer before the id filter.
      if (msg.type === 'roll-call') { this._postWindowMessage({ type: 'detached', id: this.soloSessionId }); return; }
      if (msg.id !== this.soloSessionId) return;
      if (msg.type === 'close-request') { try { window.close(); } catch {} }
      else if (msg.type === 'focus-request') { try { window.focus(); } catch {} }
      return;
    }
    // Dashboard side.
    if (msg.type === 'detached' && msg.id) {
      this._cancelPendingRedock(msg.id);    // a re-announce (e.g. popup reload) cancels a deferred redock
      this._detachPingPending?.delete(msg.id);  // and proves liveness for this tick
      this._detachOrphanStrikes.delete(msg.id); // any answer clears accumulated misses
      this._markDetached(msg.id, true);
    } else if (msg.type === 'redocked' && msg.id) {
      this._scheduleRedock(msg.id);         // defer: a popup reload fires redocked→detached; grace avoids a badge blip
    } else if (msg.type === 'detach-request' && msg.id) {
      // Future gesture hook: another window asks the dashboard to detach a tab.
      this.detachSession(msg.id);
    }
  }

  /** Dashboard: periodically reconcile detached tabs we hold no window ref for
   *  (e.g. after a dashboard reload). Owned windows are covered by the
   *  win.closed poll; channel-only ones can only be checked by asking them to
   *  re-announce and re-docking any that stay silent. */
  _startDetachLiveness() {
    if (this._detachLivenessTimer) return;
    this._detachLivenessTimer = setInterval(() => this._pingDetached(), 5000);
  }

  _pingDetached() {
    const orphans = [];
    for (const id of this.detachedSessions) {
      const win = this.detachedWindows.get(id);
      if (!win) orphans.push(id);            // channel-only — must verify via re-announce
      else if (win.closed) this._redock(id); // owned & closed — heal now
    }
    if (!orphans.length) return;
    this._detachPingPending = new Set(orphans);
    this._postWindowMessage({ type: 'roll-call' });
    // Live popups answer 'detached' (clearing themselves above); survivors stay in
    // the pending set. Redock only after TWO consecutive unanswered roll-calls — a
    // backgrounded popup is timer-throttled and may miss a single 1.2s window, and
    // we don't want to wrongly un-mark a still-open tab. A later answer resets the
    // strike count (see _onWindowMessage).
    setTimeout(() => {
      if (!this._detachPingPending) return;
      for (const id of this._detachPingPending) {
        const strikes = (this._detachOrphanStrikes.get(id) || 0) + 1;
        if (strikes >= 2) { this._detachOrphanStrikes.delete(id); this._redock(id); }
        else this._detachOrphanStrikes.set(id, strikes);
      }
      this._detachPingPending = null;
    }, 1200);
  }

  /** Solo window: select the target session and apply minimal single-session
   *  chrome. Called from handleInit once the session list has loaded. */
  _applySoloMode() {
    document.body.classList.add('solo-mode');
    const session = this.sessions.get(this.soloSessionId);
    if (!session) { this._showSoloSessionGone(); return; }
    // Force re-select (handleInit cleared terminal state above).
    this.activeSessionId = null;
    this.selectSession(this.soloSessionId);
    const name = this.getSessionName(session) || 'Session';
    const titleEl = document.getElementById('soloSessionTitle');
    if (titleEl) { titleEl.textContent = name; titleEl.style.display = ''; }
    const redock = document.getElementById('soloRedockBtn');
    if (redock) redock.style.display = '';
    document.title = name + ' — ' + (window.CodemanI18n?.displayName || 'Codeman');
    if (this.notificationManager) this.notificationManager.originalTitle = document.title;
    // Neutralize the dashboard-only brand click in a solo window.
    const logo = document.querySelector('.header-brand .logo');
    if (logo) logo.onclick = (e) => { e.preventDefault(); };
  }

  /** Solo window: the target session is gone (never existed, or ended while
   *  this window was open). Show a friendly terminal state. */
  _showSoloSessionGone() {
    document.body.classList.add('solo-mode');
    if (document.querySelector('.solo-gone-overlay')) return;
    const el = document.createElement('div');
    el.className = 'solo-gone-overlay';
    el.innerHTML = '<h2>Session unavailable</h2>'
      + '<p>This session has ended or is no longer available.</p>'
      + '<button class="btn-primary" onclick="window.close()">Close window</button>';
    document.body.appendChild(el);
    document.title = (window.codemanT?.('Session ended') || 'Session ended')
      + ' — ' + (window.CodemanI18n?.displayName || 'Codeman');
  }

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    this._clearTimer('sseReconnectTimeout');

    // Clean up existing SSE listeners before creating new connection (prevents listener accumulation)
    if (this._sseListenerCleanup) {
      this._sseListenerCleanup();
      this._sseListenerCleanup = null;
    }

    // Close existing EventSource before creating new one to prevent duplicate connections
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Show connecting state
    if (this.reconnectAttempts === 0) {
      this.setConnectionStatus('connecting');
    } else {
      this.setConnectionStatus('reconnecting');
    }

    // Build URL with stable client ID and (if known) the active-session
    // filter so the server only streams session:terminal events for the
    // session we're rendering. Lifecycle/metadata events are sent globally
    // regardless of filter (server side).
    const _sseParams = new URLSearchParams({ clientId: this._clientId });
    if (this.activeSessionId) _sseParams.set('sessions', this.activeSessionId);
    this.eventSource = new EventSource(`/api/events?${_sseParams.toString()}`);

    // Store all event listeners for cleanup on reconnect
    const listeners = [];
    const addListener = (event, handler) => {
      this.eventSource.addEventListener(event, handler);
      listeners.push({ event, handler });
    };

    // Create cleanup function to remove all listeners
    this._sseListenerCleanup = () => {
      for (const { event, handler } of listeners) {
        if (this.eventSource) {
          this.eventSource.removeEventListener(event, handler);
        }
      }
      listeners.length = 0;
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionStatus('connected');
    };
    this.eventSource.onerror = () => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setConnectionStatus('disconnected');
      } else {
        this.setConnectionStatus('reconnecting');
      }
      // Close the failed connection before scheduling reconnect
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Clear any existing reconnect timeout before setting new one (prevents orphaned timeouts)
      this._clearTimer('sseReconnectTimeout');
      // Exponential backoff: 200ms, 500ms, 1s, 2s, 4s, ... up to 30s
      // Fast first retry (200ms) for server-restart case (COM deploy),
      // then ramp up for real network issues.
      const delay = this.reconnectAttempts <= 1 ? 200
        : Math.min(500 * Math.pow(2, this.reconnectAttempts - 2), 30000);
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    // Create stable handler wrappers once (reused across reconnects so
    // removeEventListener always matches the original reference)
    if (!this._sseHandlerWrappers) {
      this._sseHandlerWrappers = new Map();
      for (const [event, method] of _SSE_HANDLER_MAP) {
        const fn = this[method];
        this._sseHandlerWrappers.set(event, (e) => {
          try {
            fn.call(this, e.data ? JSON.parse(e.data) : {});
          } catch (err) {
            console.error(`[SSE] Error handling ${event}:`, err);
          }
        });
      }
    }

    // Register all SSE event handlers via centralized map
    for (const [event] of _SSE_HANDLER_MAP) {
      addListener(event, this._sseHandlerWrappers.get(event));
    }

    // COD-121: live-refresh the unified session list (Session Manager modal +
    // visible welcome list) on session structural changes. Extra listeners on the
    // same EventSource — EventSource supports multiple listeners per event — so the
    // existing handlers above are untouched. Registered through addListener so they
    // are torn down with the rest on reconnect.
    for (const event of [SSE_EVENTS.SESSION_CREATED, SSE_EVENTS.SESSION_UPDATED, SSE_EVENTS.SESSION_DELETED]) {
      addListener(event, () => this._onSessionListMaybeChanged());
    }

    // Docker export/import: toast + refresh the Manage-tab exports list on completion.
    addListener(SSE_EVENTS.DOCKER_EXPORT_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker export ready: ${d.bundle} (${Math.round((d.sizeBytes || 0) / 1e6)} MB)`, 'success');
        this.refreshDockerExports?.();
      } catch (err) {
        console.error('[SSE] docker export complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_EXPORT_FAILED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker export failed: ${d.error || 'unknown error'}`, 'error');
      } catch (err) {
        console.error('[SSE] docker export failed:', err);
      }
    });
    // Import + drift-recreate completions: refresh case lists in EVERY open tab
    // (the initiating tab already refreshes via its own fetch response).
    addListener(SSE_EVENTS.DOCKER_IMPORT_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker bundle imported as case "${d.name}"`, 'success');
        this.loadQuickStartCases?.();
        this.refreshDockerExports?.();
      } catch (err) {
        console.error('[SSE] docker import complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_CONTAINER_RECREATED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Container for "${d.name}" removed — next launch recreates it with the new config`, 'info');
      } catch (err) {
        console.error('[SSE] docker container recreated:', err);
      }
    });
    // Multi-user admin: live-refresh whichever admin views (panel/Users tab) are open.
    addListener(SSE_EVENTS.ADMIN_USERS_CHANGED, () => {
      window.codemanAdmin?.onUsersChanged?.();
    });
    // Base image auto-build on first Docker case (build-on-first-use). A single
    // multi-minute event; surface start/finish so the Run spinner is explained.
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_STARTED, () => {
      this.showToast('Building the Codeman agent image (first Docker case, a few minutes)...', 'info', {
        duration: 8000,
      });
    });
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        if (d.error) this.showToast(`Agent image build failed: ${d.error}`, 'error');
        else this.showToast('Agent image ready. Starting the container...', 'success');
      } catch (err) {
        console.error('[SSE] docker image build complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_FAILED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Agent image build failed: ${d.error || 'unknown error'}`, 'error');
      } catch (err) {
        console.error('[SSE] docker image build failed:', err);
      }
    });

    // COD-139: a session:pinned event updates the local live-session pin flag (so
    // a subsequent render is consistent) and re-sorts the open session manager /
    // welcome list so pinned sessions float to the top.
    addListener(SSE_EVENTS.SESSION_PINNED, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        /* ignore malformed payload */
      }
      if (data && data.id) {
        const live = this.sessions.get(data.id);
        if (live) {
          live.pinned = data.pinned === true;
          live.pinnedAt = data.pinned ? data.pinnedAt : undefined;
        }
      }
      this._onSessionListMaybeChanged();
    });

    // COD-124: session:parked / session:resumed carry only {id} — the new
    // status lives locally, mirroring the session-park/resume-session flow
    // in terminal-ui.js, so rows update live without a reload.
    addListener(SSE_EVENTS.SESSION_PARKED, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        /* ignore malformed payload */
      }
      if (data && data.id) {
        const live = this.sessions.get(data.id);
        if (live) live.status = 'parked';
      }
      this._onSessionListMaybeChanged();
    });

    addListener(SSE_EVENTS.SESSION_RESUMED, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        /* ignore malformed payload */
      }
      if (data && data.id) {
        const live = this.sessions.get(data.id);
        if (live) live.status = 'active';
      }
      this._onSessionListMaybeChanged();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Event Handlers
  // ═══════════════════════════════════════════════════════════════
  // Each _on* method receives pre-parsed SSE data (JSON.parse done in connectSSE loop).
  // Async handlers have their own internal try/catch for fetch errors.

  _onInit(data) {
    _crashDiag.log(`INIT: ${data.sessions?.length || 0} sessions`);
    this.handleInit(data);
  }

  _onSessionCreated(data) {
    this.sessions.set(data.id, data);
    this.updateAttachmentHistoryCountFromSession?.(data);
    // Add new session to end of tab order
    if (!this.sessionOrder.includes(data.id)) {
      this.sessionOrder.push(data.id);
      this.saveSessionOrder();
    }
    this.renderSessionTabs();
    this.updateCost();
    // COD-97: keep the Monitor's mux list in sync with the open tabs.
    this.renderMuxSessions();
    // Start stats polling when first session appears
    if (this.sessions.size === 1) this.startSystemStatsPolling();
  }

  _onSessionUpdated(data) {
    const session = data.session || data;
    const oldSession = this.sessions.get(session.id);
    const claudeSessionIdJustSet = session.claudeSessionId && (!oldSession || !oldSession.claudeSessionId);
    this.sessions.set(session.id, session);
    this.updateAttachmentHistoryCountFromSession?.(session);
    this.renderSessionTabs();
    this.updateCost();
    // Update tokens display if this is the active session
    if (session.id === this.activeSessionId && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
    // Update parentSessionName for any subagents belonging to this session
    // (fixes stale name display after session rename)
    this.updateSubagentParentNames(session.id);
    // If claudeSessionId was just set, re-check orphan subagents
    // This connects subagents that were waiting for the session to identify itself
    if (claudeSessionIdJustSet) {
      this.recheckOrphanSubagents();
      // Update connection lines after DOM settles (ensure tabs are rendered)
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });
    }
  }

  _onSessionDeleted(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    // Solo window whose session just ended → show the "unavailable" state.
    if (this.isSoloWindow && data.id === this.soloSessionId) {
      this._showSoloSessionGone();
    }
    // Dashboard: a detached session ended → clear its detached state/timers.
    if (this.detachedSessions.has(data.id)) this._redock(data.id);
    this._cleanupSessionData(data.id);
    if (this.activeSessionId === data.id) {
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.terminal.clear();
      this.showWelcome();
    }
    this.renderSessionTabs();
    // COD-97: re-render the Monitor so the closed session's row disappears
    // immediately, instead of relying solely on a MUX_KILLED event that may race.
    this.renderMuxSessions();
    this.renderRalphStatePanel();  // Update ralph panel after session deleted
    this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
    // Stop stats polling when no sessions remain
    if (this.sessions.size === 0) this.stopSystemStatsPolling();
  }

  // SSE wrappers — skip terminal events when WebSocket is delivering for this session.
  // WS handler calls the underlying _onSession* methods directly.
  _onSSETerminal(data) {
    if (this._wsReady && this._wsSessionId === data.id) return;
    this._onSessionTerminal(data);
  }
  _onSSENeedsRefresh(data) {
    if (this._wsReady && this._wsSessionId === data?.id) return;
    this._onSessionNeedsRefresh(data);
  }
  _onSSEClearTerminal(data) {
    if (this._wsReady && this._wsSessionId === data?.id) return;
    this._onSessionClearTerminal(data);
  }

  _onSessionTerminal(data) {
    if (data.id === this.activeSessionId) {
      // COD-187: while frozen in the history view, live output is dropped —
      // the exit-time frame refetch shows the final state. Flag it so the
      // pill can advertise "new output below".
      if (this._viewMode === 'history' && this._isMirrorSession(data.id)) {
        if (!this._historyMissedOutput) {
          this._historyMissedOutput = true;
          this._updateHistoryPill?.();
        }
        return;
      }
      if (data.data.length > 32768) _crashDiag.log(`TERMINAL: ${(data.data.length/1024).toFixed(0)}KB`);

      // Hard cap: track total bytes queued in render buffers (pendingWrites +
      // flickerFilterBuffer). When rAF is throttled (tab backgrounded, GPU
      // busy), data accumulates with no flush, reaching 889KB+ and freezing
      // Chrome for minutes. Drop data beyond 128KB and schedule a buffer
      // reload to recover the display once the burst subsides.
      const queued = (this.pendingWrites?.reduce((s, w) => s + w.length, 0) || 0)
        + (this.flickerFilterBuffer?.length || 0);
      if (queued > 131072) { // 128KB — drop to prevent accumulation
        // Schedule a self-recovery: reload the full terminal buffer once the
        // queue drains (debounced to avoid hammering the API during sustained bursts).
        if (!this._clientDropRecoveryTimer) {
          this._clientDropRecoveryTimer = setTimeout(() => {
            this._clientDropRecoveryTimer = null;
            this._onSessionNeedsRefresh();
          }, 2000);
        }
        return;
      }

      this.batchTerminalWrite(data.data);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Response Viewer — native-scroll panel for reading full Claude responses
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sanitize markdown-rendered HTML before innerHTML assignment (XSS / mXSS prevention).
   *
   * COD-56: delegates to DOMPurify (Cure53) via sanitize-html.js — an allowlist sanitizer that
   * is the industry standard for mXSS defense. It replaces the previous hand-rolled DENYLIST,
   * which never stripped `svg`/`math` (foreign-namespace mXSS vectors) or `style` (CSS-based
   * vectors) and admitted any tag/attr it didn't explicitly name. The allowlist config lives in
   * sanitize-html.js and permits only what markdown rendering produces.
   *
   * Fallback: if DOMPurify failed to load, fail CLOSED by escaping the entire string into a
   * single text node rather than serving the raw (unsanitized) HTML.
   */
  _sanitizeHtml(html) {
    if (typeof window !== 'undefined' && typeof window.sanitizeMarkdownHtml === 'function') {
      return window.sanitizeMarkdownHtml(html);
    }
    // Fail closed: DOMPurify unavailable — never return un-sanitized HTML.
    return String(html == null ? '' : html)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Strip ANSI escape sequences and Claude CLI chrome (status bar, hints,
   * spinner, progress bar) from a terminal buffer so the response viewer can
   * show just the conversational text when the JSONL transcript is missing.
   */
  _cleanTerminalBuffer(buf) {
    const stripped = buf
      // CSI sequences — params (0x30-0x3F includes digits, ?, ;, <, =, >),
      // intermediates (0x20-0x2F), final byte (0x40-0x7E). Catches \x1b[>c,
      // \x1b[>q, \x1b[?25l etc. that the previous regex missed.
      .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
      // OSC sequences (window titles etc.) terminated by BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // DCS / APC / PM / SOS sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      // SS2/SS3 + charset selects + single-char escapes
      .replace(/\x1b[NO()][A-Z0-9]?/g, '')
      .replace(/\x1b[>=<78cDEHM]/g, '')
      // Stray control chars (except \t \n)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Drop Claude CLI chrome lines that aren't part of the response.
    const CHROME_PATTERNS = [
      /^\s*❯\s*/,                                  // shell prompt
      /^\s*[⏵⏺⏸⏹]+\s*/,                           // status glyphs
      /^\s*✻\s*(Crunching|Crunched|Thinking)/i,   // spinner lines
      /bypass permissions/i,
      /\bshift\+tab to cycle\b/i,
      /^\s*focus\s*$/,
      /^\s*new task\?/i,
      /\/clear to save/i,
      /^\s*─{5,}\s*$/,                            // horizontal dividers
      /\[(Opus|Sonnet|Haiku|GPT|Claude)[\s\S]*(tokens?|\$|¥|%|↑|↓)/i, // status bar
      /^\s*\[\d+[km]?\/\d+[km]?\]/i,              // token counter
      /[█░▓▒]{3,}/,                              // progress bar
      /^\s*\(.*\s*(tokens?|context).*\)\s*$/i,
    ];

    const lines = stripped.split('\n');
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true; // keep blanks so paragraphs survive
      return !CHROME_PATTERNS.some((re) => re.test(line));
    });

    return kept
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  /**
   * Wrap ASCII/box diagrams in fenced code blocks so marked.js preserves whitespace.
   * Claude often emits box-drawing diagrams without triple-backticks; without this
   * step, HTML collapses the whitespace and the diagram becomes unreadable prose.
   */
  _preprocessAsciiArt(text) {
    // Only trigger on characters that rarely appear in prose:
    //   U+2500-U+257F  Box Drawing      (─│┌┐└┘├┤┬┴┼╔╗╚╝═║)
    //   U+2580-U+259F  Block Elements   (▀▄█▌▐░▒▓, progress bars)
    // Deliberately excluded:
    //   U+2190-U+21FF  Arrows           (→←↑↓⇒ — common rhetorical prose)
    //   U+25A0-U+25FF  Geometric Shapes (●○■□◆◇ — common bullets)
    // Triggering on those would wrap numbered lists / prose that merely uses
    // arrows in code blocks and break their markdown rendering.
    const BOX_PATTERN = /[─-╿▀-▟]/;

    // Preserve existing fenced code blocks as-is (hide them behind placeholders)
    const fenceRe = /```[\s\S]*?```/g;
    const placeholders = [];
    const masked = text.replace(fenceRe, (m) => {
      placeholders.push(m);
      return `__CODEMAN_FENCE_${placeholders.length - 1}__`;
    });

    const looksLikeAsciiArtBlock = (chunk) => {
      const lines = chunk.split('\n').filter((line) => line.trim());
      if (lines.length === 0) return false;
      if (lines.every((line) => /^[-*+]\s|^\d+[.)]\s/.test(line.trim()))) return false;
      const boxLines = lines.filter((line) => BOX_PATTERN.test(line));
      if (boxLines.length === 0) return false;
      // Inline mentions such as "separator lines like ─────" are prose, not diagrams.
      // Treat a chunk as ASCII art only when multiple lines carry box glyphs,
      // or when a single non-empty line is predominantly box-drawing content.
      if (boxLines.length >= 2) return true;
      const onlyLine = boxLines[0];
      const nonSpace = onlyLine.replace(/\s+/g, '');
      const boxChars = (nonSpace.match(/[─-╿▀-▟]/g) || []).length;
      return nonSpace.length >= 16 && boxChars / nonSpace.length >= 0.45;
    };

    // Split on blank-line paragraph boundaries; wrap actual box-drawing blocks
    // in fenced code, but leave ordinary prose that merely mentions those glyphs
    // alone so response text stays proportional and copy-friendly.
    const processed = masked
      .split(/(\n{2,})/)
      .map((chunk) => {
        if (/^\n{2,}$/.test(chunk)) return chunk; // keep separators
        if (!chunk.trim()) return chunk;
        if (chunk.includes('__CODEMAN_FENCE_')) return chunk;
        if (looksLikeAsciiArtBlock(chunk)) return '\n```\n' + chunk + '\n```\n';
        return chunk;
      })
      .join('');

    return processed.replace(/__CODEMAN_FENCE_(\d+)__/g, (_m, i) => placeholders[Number(i)]);
  }

  /** Render markdown to sanitized HTML, falling back to plain text if marked.js unavailable */
  _renderMarkdown(text) {
    const src = text || '';
    if (typeof marked !== 'undefined' && marked.parse) {
      try {
        const prepared = this._preprocessAsciiArt(src);
        let html = this._sanitizeHtml(marked.parse(prepared, { breaks: true, gfm: true }));
        // Wrap tables in a horizontal-scroll container so they overflow gracefully
        // on mobile without collapsing into block-level cells.
        html = html.replace(/<table>/g, '<div class="rv-table-wrap"><table>')
                   .replace(/<\/table>/g, '</table></div>');
        // Tag code blocks containing box-drawing glyphs as diagrams (same
        // narrow trigger as _preprocessAsciiArt — arrows/geometric shapes
        // don't count because they appear frequently in prose).
        // Default is wrap (readable on mobile); a toggle button lets the user
        // switch to horizontal-scroll mode when the original structure matters.
        // The button must live OUTSIDE the <pre> scroll container so it stays
        // pinned to the visual right edge when the user scrolls horizontally.
        const DIAGRAM_CHAR = /[─-╿▀-▟]/;
        const tmpl = document.createElement('template');
        tmpl.innerHTML = html;
        // Every fenced code block gets a positioned wrapper with an action
        // toolbar pinned to its top-right corner. The toolbar lives OUTSIDE the
        // <pre> scroll container so its buttons stay put during horizontal
        // scroll. All blocks get a one-click copy button; ASCII diagrams keep
        // the additional line-wrap toggle.
        tmpl.content.querySelectorAll('pre > code').forEach((code) => {
          const pre = code.parentElement;
          const isDiagram = DIAGRAM_CHAR.test(code.textContent || '');

          const wrap = document.createElement('div');
          wrap.className = isDiagram ? 'rv-code-wrap rv-diagram-wrap' : 'rv-code-wrap';

          const actions = document.createElement('div');
          actions.className = 'rv-code-actions';

          const copyBtn = document.createElement('button');
          copyBtn.className = 'rv-copy-btn';
          copyBtn.type = 'button';
          copyBtn.setAttribute('aria-label', 'Copy code');
          copyBtn.setAttribute('title', 'Copy code');
          actions.appendChild(copyBtn);

          if (isDiagram) {
            pre.classList.add('rv-diagram');
            const toggle = document.createElement('button');
            toggle.className = 'rv-wrap-toggle';
            toggle.type = 'button';
            toggle.setAttribute('aria-label', 'Toggle line wrapping');
            toggle.setAttribute('title', 'Toggle line wrapping');
            actions.appendChild(toggle);
          }

          pre.parentNode.insertBefore(wrap, pre);
          wrap.appendChild(actions);
          wrap.appendChild(pre);
        });
        return tmpl.innerHTML;
      } catch { /* fall through */ }
    }
    // Fallback: escape HTML and preserve whitespace
    const escaped = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;word-break:break-word">${escaped}</pre>`;
  }

  /**
   * Resolve an explicit response-viewer link to a safe workspace-relative preview path.
   * The server remains the authoritative filesystem-containment boundary.
   */
  _resolveResponseViewerPreviewPath(rawHref, workingDir) {
    if (!rawHref || String(rawHref).length > 3000) return null;

    let candidate;
    try {
      candidate = decodeURIComponent(String(rawHref));
    } catch {
      return null;
    }

    if (
      !candidate ||
      candidate.length > 1000 ||
      candidate.includes('\\') ||
      candidate.includes('?') ||
      candidate.includes('#') ||
      /[\x00-\x1f\x7f]/.test(candidate) ||
      /^[a-z][a-z0-9+.-]*:/i.test(candidate)
    ) {
      return null;
    }

    const previewExtensions = new Set([
      'pdf',
      'md',
      'txt',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'docx',
      'pptx',
      'xlsx',
      'json',
      'yaml',
      'yml',
      'csv',
      'xml',
      'sh',
      'py',
      'ts',
      'js',
    ]);
    const extension = candidate.slice(candidate.lastIndexOf('.') + 1).toLowerCase();
    if (!previewExtensions.has(extension)) return null;

    const normalizePath = (filePath, absolute) => {
      if (absolute && filePath === '/') return '/';
      const normalized = [];
      for (const [index, part] of filePath.split('/').entries()) {
        if (!part) {
          if (absolute && index === 0) continue;
          return null;
        }
        if (part === '.') continue;
        if (part === '..') return null;
        normalized.push(part);
      }
      if (!normalized.length) return null;
      return `${absolute ? '/' : ''}${normalized.join('/')}`;
    };

    if (!candidate.startsWith('/')) return normalizePath(candidate, false);

    const normalizedCandidate = normalizePath(candidate, true);
    const rawWorkingDir = String(workingDir || '');
    const normalizedWorkingDir = normalizePath(
      rawWorkingDir === '/' ? rawWorkingDir : rawWorkingDir.replace(/\/+$/, ''),
      true
    );
    if (!normalizedCandidate || !normalizedWorkingDir) return null;
    const workspacePrefix = normalizedWorkingDir === '/' ? '/' : `${normalizedWorkingDir}/`;
    return normalizedCandidate.startsWith(workspacePrefix)
      ? normalizedCandidate.slice(workspacePrefix.length)
      : null;
  }

  /**
   * Bind click handlers inside the response viewer body. Uses event delegation
   * so a single listener serves every diagram-toggle button, including those
   * added when the conversation is reloaded. Idempotent via a dataset flag.
   */
  _bindResponseViewerInteractions(body, responseSessionId = null) {
    if (!body) return;
    if (responseSessionId) body.dataset.rvSessionId = responseSessionId;
    if (body.dataset.rvBound === '1') return;
    body.dataset.rvBound = '1';
    body.addEventListener('click', async (ev) => {
      const messageCopyBtn = ev.target.closest('.rv-message-copy');
      if (messageCopyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const message = messageCopyBtn.closest('.rv-message');
        const source = message?.querySelector('.rv-text');
        await this._copyResponseViewerPayload(this._prepareResponseViewerClipboard(source), {
          controlEl: messageCopyBtn,
          successMessage: 'Copied section as rich text',
          fallbackMessage: 'Rich clipboard unavailable; copied section as plain text',
          emptyMessage: 'No section content to copy',
          failureMessage: 'Failed to copy section',
        });
        return;
      }

      // One-click copy: lift the raw source from the sibling <pre><code>.
      const copyBtn = ev.target.closest('.rv-copy-btn');
      if (copyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const code = copyBtn.closest('.rv-code-wrap')?.querySelector('pre code');
        const ok = code ? await this._copyText(code.textContent || '') : false;
        copyBtn.classList.remove('rv-copied', 'rv-copy-failed');
        copyBtn.classList.add(ok ? 'rv-copied' : 'rv-copy-failed');
        clearTimeout(copyBtn._resetTimer);
        copyBtn._resetTimer = setTimeout(() => {
          copyBtn.classList.remove('rv-copied', 'rv-copy-failed');
        }, 1500);
        return;
      }

      const link = ev.target.closest('a[href]');
      const sessionId = body.dataset.rvSessionId || '';
      if (link && sessionId) {
        const session = this.sessions?.get?.(sessionId);
        const previewPath = this._resolveResponseViewerPreviewPath(
          link.getAttribute('href'),
          session?.workingDir
        );
        if (previewPath) {
          ev.preventDefault();
          ev.stopPropagation();
          this.openFilePreview(previewPath, sessionId);
          return;
        }
      }

      const btn = ev.target.closest('.rv-wrap-toggle');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = btn.closest('.rv-diagram-wrap');
      const pre = wrap?.querySelector('pre.rv-diagram');
      if (!pre || !wrap) return;
      const nowrap = pre.classList.toggle('rv-nowrap');
      wrap.classList.toggle('rv-wrap-nowrap', nowrap);
    });
  }

  /**
   * Copy text to the clipboard. Prefers the async Clipboard API (secure
   * contexts); falls back to a hidden-textarea + execCommand path so copy
   * still works over plain HTTP. Returns true on success.
   */
  async _copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* secure-context write failed — try the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  _getResponseViewerCopySource(body) {
    if (!body) return null;
    const responseBlocks = body.querySelectorAll('[data-copy-role="response"] .rv-text');
    if (responseBlocks.length > 0) return responseBlocks[responseBlocks.length - 1];
    return body;
  }

  _getResponseViewerPlainText(source) {
    const textSource = source.cloneNode(true);
    textSource.querySelectorAll('br').forEach((lineBreak) => lineBreak.replaceWith(document.createTextNode('\n')));
    textSource.querySelectorAll('ol').forEach((list) => {
      const parsedStart = Number.parseInt(list.getAttribute('start') || '1', 10);
      const start = Number.isNaN(parsedStart) ? 1 : parsedStart;
      const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
      items.forEach((item, index) => {
        item.insertBefore(document.createTextNode(`${start + index}. `), item.firstChild);
      });
    });
    textSource.querySelectorAll('ul').forEach((list) => {
      Array.from(list.children)
        .filter((child) => child.tagName === 'LI')
        .forEach((item) => item.insertBefore(document.createTextNode('• '), item.firstChild));
    });
    textSource.querySelectorAll('li > ol, li > ul').forEach((list) => list.before(document.createTextNode('\n')));
    textSource.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.children).filter((child) => child.tagName === 'TD' || child.tagName === 'TH');
      cells.slice(1).forEach((cell) => cell.before(document.createTextNode('\t')));
    });
    textSource.querySelectorAll('blockquote, div, h1, h2, h3, h4, h5, h6, hr, li, p, pre, tr').forEach((block) => {
      block.after(document.createTextNode('\n'));
    });

    return (textSource.innerText || textSource.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Build a portable clipboard fragment from the rendered response viewer. */
  _prepareResponseViewerClipboard(body) {
    if (!body) return null;

    const clone = body.cloneNode(true);
    clone.querySelectorAll('.rv-code-actions').forEach((actions) => actions.remove());

    // These wrappers only provide Codeman scrolling/toolbar behavior. Keep their content.
    clone.querySelectorAll('.rv-code-wrap, .rv-table-wrap').forEach((wrapper) => {
      wrapper.replaceWith(...Array.from(wrapper.childNodes));
    });

    // Retain semantic markup and links, but do not leak app-specific classes or data attributes.
    const portableAttributes = new Set([
      'alt', 'colspan', 'height', 'href', 'rowspan', 'src', 'start', 'title', 'type', 'width',
    ]);
    clone.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        if (!portableAttributes.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
      });
    });

    // Small neutral styles survive Office-style paste targets without carrying the dark theme.
    clone.querySelectorAll('table').forEach((table) => {
      table.style.borderCollapse = 'collapse';
    });
    clone.querySelectorAll('th, td').forEach((cell) => {
      cell.style.border = '1px solid #999';
      cell.style.padding = '4px 8px';
    });
    clone.querySelectorAll('pre').forEach((pre) => {
      pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
      pre.style.whiteSpace = 'pre-wrap';
    });
    clone.querySelectorAll('code').forEach((code) => {
      code.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
    });
    clone.querySelectorAll('blockquote').forEach((quote) => {
      quote.style.borderLeft = '3px solid #999';
      quote.style.marginLeft = '0';
      quote.style.paddingLeft = '12px';
    });

    const html = clone.innerHTML.trim();
    const text = this._getResponseViewerPlainText(clone);
    return html || text ? { html, text } : null;
  }

  _setResponseViewerCopyState(success) {
    const btn = document.getElementById('responseViewerCopy');
    this._setCopyControlState(btn, success);
  }

  _setCopyControlState(btn, success) {
    if (!btn) return;
    btn.classList.remove('rv-copied', 'rv-copy-failed');
    btn.classList.add(success ? 'rv-copied' : 'rv-copy-failed');
    clearTimeout(btn._resetTimer);
    btn._resetTimer = setTimeout(() => {
      btn.classList.remove('rv-copied', 'rv-copy-failed');
    }, 1500);
  }

  async _copyResponseViewerPayload(payload, options = {}) {
    const {
      controlEl = null,
      successMessage = 'Copied response as rich text',
      fallbackMessage = 'Rich clipboard unavailable; copied plain text',
      emptyMessage = 'No response content to copy',
      failureMessage = 'Failed to copy response',
    } = options;

    const setState = (success) => {
      if (controlEl) this._setCopyControlState(controlEl, success);
      else this._setResponseViewerCopyState(success);
    };

    if (!payload) {
      setState(false);
      this.showToast(emptyMessage, 'warning');
      return;
    }

    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Rich clipboard API unavailable');
      }
      const item = new ClipboardItem({
        'text/html': new Blob([payload.html], { type: 'text/html' }),
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      setState(true);
      this.showToast(successMessage, 'success');
      return;
    } catch { /* Fall through to the established plain-text copy path. */ }

    const copied = await this._copyText(payload.text);
    setState(copied);
    if (copied) {
      this.showToast(fallbackMessage, 'warning');
    } else {
      this.showToast(failureMessage, 'error');
    }
  }

  /** Copy the currently displayed response as HTML with a plain-text fallback. */
  async copyResponseViewerRichText() {
    const body = document.getElementById('responseViewerBody');
    await this._copyResponseViewerPayload(
      this._prepareResponseViewerClipboard(this._getResponseViewerCopySource(body))
    );
  }

  /** Copy the raw Markdown source of the latest response without rendering it first. */
  async copyResponseViewerMarkdown() {
    const button = document.getElementById('responseViewerCopyMarkdown');
    const markdown = this._responseViewerMarkdown || '';
    if (!markdown) {
      this._setCopyControlState(button, false);
      this.showToast('No response content to copy', 'warning');
      return;
    }

    const copied = await this._copyText(markdown);
    this._setCopyControlState(button, copied);
    this.showToast(copied ? 'Copied response as Markdown' : 'Failed to copy response as Markdown', copied ? 'success' : 'error');
  }

  _renderResponseViewerMessages(body, messages, responseSessionId = this.activeSessionId) {
    body.innerHTML = '';
    for (const msg of messages) {
      const kind = msg.kind || (msg.role === 'user' ? 'prompt' : 'response');
      const label = msg.label || (msg.role === 'user' ? 'You' : 'Claude');
      const div = document.createElement('div');
      div.className = 'rv-message rv-msg-' + kind;
      if (kind === 'response') div.dataset.copyRole = 'response';

      const actions = document.createElement('div');
      actions.className = 'rv-message-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'rv-message-copy';
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', `Copy ${label} block as rich text`);
      copyBtn.setAttribute('title', `Copy ${label}`);
      actions.appendChild(copyBtn);
      div.appendChild(actions);

      const role = document.createElement('div');
      role.className = 'rv-role rv-role-' + kind;
      role.textContent = label;
      div.appendChild(role);

      const text = document.createElement('div');
      text.className = 'rv-text';
      text.innerHTML = this._renderMarkdown(msg.text || '');
      div.appendChild(text);

      body.appendChild(div);
    }
    this._bindResponseViewerInteractions(body, responseSessionId);
  }

  // COD-225: independent User / Tools / Responses visibility filters for the
  // expanded More transcript. Pure client-side show/hide (no refetch); block order
  // is untouched. Category -> block kinds: user -> prompt; tool -> tool + status;
  // response -> response.
  _defaultResponseFilterState() {
    return { user: true, tool: true, response: true };
  }

  toggleTranscriptFilter(category, btn) {
    if (!['user', 'tool', 'response'].includes(category)) return;
    if (!this._responseFilterState) this._responseFilterState = this._defaultResponseFilterState();
    const on = !this._responseFilterState[category];
    this._responseFilterState[category] = on;
    const button = btn || document.querySelector(`.rv-filter-btn[data-rv-filter="${category}"]`);
    if (button) {
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.classList.toggle('rv-filter-off', !on);
    }
    this._applyResponseFilters();
  }

  _applyResponseFilters() {
    const body = document.getElementById('responseViewerBody');
    if (!body) return;
    const st = this._responseFilterState || this._defaultResponseFilterState();
    body.classList.toggle('rv-hide-user', !st.user);
    body.classList.toggle('rv-hide-tool', !st.tool);
    body.classList.toggle('rv-hide-response', !st.response);

    // Derive the filtered-empty state from classes (not computed CSS display, which
    // jsdom does not evaluate). A block is hidden when its category is toggled off.
    const blocks = body.querySelectorAll('.rv-message');
    let anyVisible = false;
    blocks.forEach((b) => {
      const hidden =
        (!st.user && b.classList.contains('rv-msg-prompt')) ||
        (!st.tool && (b.classList.contains('rv-msg-tool') || b.classList.contains('rv-msg-status'))) ||
        (!st.response && b.classList.contains('rv-msg-response'));
      if (!hidden) anyVisible = true;
    });

    let empty = body.querySelector('.response-viewer-filter-empty');
    if (blocks.length > 0 && !anyVisible) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'response-viewer-filter-empty';
        empty.textContent = 'No transcript blocks match the current filters.';
        body.appendChild(empty);
      }
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }
  }

  // Show the filter bar and return every category to visible, so reopening the
  // transcript starts from a predictable all-visible default (COD-225).
  _showResponseFilters() {
    this._responseFilterState = this._defaultResponseFilterState();
    const bar = document.getElementById('responseViewerFilters');
    if (bar) {
      bar.hidden = false;
      bar.querySelectorAll('.rv-filter-btn').forEach((b) => {
        b.setAttribute('aria-pressed', 'true');
        b.classList.remove('rv-filter-off');
      });
    }
    this._applyResponseFilters();
  }

  // Hide the filter bar for the Last Response single-response view (no transcript
  // blocks to filter) and clear any lingering hide classes.
  _hideResponseFilters() {
    const bar = document.getElementById('responseViewerFilters');
    if (bar) bar.hidden = true;
    const body = document.getElementById('responseViewerBody');
    if (body) body.classList.remove('rv-hide-user', 'rv-hide-tool', 'rv-hide-response');
  }

  // Explicit, idempotent close for the View Response overlay. Returns true only
  // when it actually closed an open viewer (so the Escape handler can consume the
  // key), false if it was already closed. Restores focus to the active terminal so
  // a keyboard user resumes typing at the CLI prompt with no mouse click (COD-229).
  // Shared by the × button, the backdrop, the toggle's close branch, and Escape.
  closeResponseViewer() {
    const viewer = document.getElementById('responseViewer');
    if (!viewer || !viewer.classList.contains('visible')) return false;
    const backdrop = document.getElementById('responseViewerBackdrop');
    viewer.classList.remove('visible');
    if (backdrop) backdrop.classList.remove('visible');
    if (this.terminal) {
      try {
        this.terminal.focus();
      } catch {
        /* terminal may be detached mid-teardown */
      }
    }
    return true;
  }

  // Escape-key seam: close the viewer if open and consume the event so ESC does not
  // reach xterm/the CLI. Returns true when the key was consumed (COD-229).
  _maybeCloseResponseViewerOnEscape(e) {
    if (!this.closeResponseViewer()) return false;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    return true;
  }

  async toggleResponseViewer() {
    const viewer = document.getElementById('responseViewer');
    const backdrop = document.getElementById('responseViewerBackdrop');
    if (!viewer) return;

    const isOpen = viewer.classList.contains('visible');
    if (isOpen) {
      this.closeResponseViewer();
      return;
    }

    if (!this.activeSessionId) return;
    const responseSessionId = this.activeSessionId;
    try {
      const session = this.sessions?.get?.(responseSessionId);
      const mode = session?.mode || '';
      // Source 1: Transcript JSONL (best quality — clean structured text from Claude)
      const res = await fetch(`/api/sessions/${responseSessionId}/last-response`);
      const data = (await res.json())?.data ?? {};
      let lastResponse = data.text || '';

      // Source 2: Terminal buffer fallback — strip ANSI, drop Claude CLI chrome
      if (!lastResponse && mode === 'claude') {
        const termRes = await fetch(`/api/sessions/${responseSessionId}/terminal`);
        const termData = (await termRes.json())?.data ?? {};
        if (termData.terminalBuffer) {
          lastResponse = this._cleanTerminalBuffer(termData.terminalBuffer);
        }
      }

      this._responseViewerMarkdown = lastResponse;

      const body = document.getElementById('responseViewerBody');
      if (lastResponse) {
        body.innerHTML = this._renderMarkdown(lastResponse);
        this._bindResponseViewerInteractions(body, responseSessionId);
      } else {
        body.textContent =
          window.codemanT?.('No response yet — send a message in this session first.') ||
          'No response yet — send a message in this session first.';
      }

      // Reset state for fresh open
      const title = document.getElementById('responseViewerTitle');
      const moreBtn = document.getElementById('responseViewerMore');
      if (title) title.textContent = 'Last Response';
      if (moreBtn) {
        moreBtn.style.display = data.hasContext ? '' : 'none';
        moreBtn.textContent = 'More';
      }
      // Last Response is a single rendered block, not a transcript — no filters here.
      this._hideResponseFilters();

      viewer.classList.add('visible');
      backdrop.classList.add('visible');
      body.scrollTop = 0;
    } catch (err) {
      console.error('Failed to load response:', err);
    }
  }

  async loadFullContext() {
    if (!this.activeSessionId) return;
    const responseSessionId = this.activeSessionId;
    const moreBtn = document.getElementById('responseViewerMore');
    if (moreBtn) moreBtn.textContent = '...';
    try {
      const res = await fetch(`/api/sessions/${responseSessionId}/last-response?context=full`);
      const data = (await res.json())?.data ?? {};
      const messages = data.messages || [];
      const body = document.getElementById('responseViewerBody');
      const title = document.getElementById('responseViewerTitle');
      if (!body) return;

      if (messages.length === 0) {
        body.textContent = 'No conversation history available';
        return;
      }

      const lastResponse = [...messages].reverse().find((msg) => {
        const kind = msg.kind || (msg.role === 'user' ? 'prompt' : 'response');
        return kind === 'response';
      });
      if (lastResponse) this._responseViewerMarkdown = lastResponse.text || '';

      this._renderResponseViewerMessages(body, messages, responseSessionId);
      this._showResponseFilters();

      const hasStructuredKinds = messages.some((msg) => typeof msg.kind === 'string');
      if (title) title.textContent = hasStructuredKinds
        ? `Transcript (${messages.length} blocks)`
        : `Conversation (${messages.length} messages)`;
      if (moreBtn) moreBtn.style.display = 'none';
      // Scroll to bottom (latest message)
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      console.error('Failed to load context:', err);
    } finally {
      if (moreBtn) moreBtn.textContent = 'More';
    }
  }

  async _onSessionNeedsRefresh() {
    // Server sends this after SSE backpressure clears — terminal data was dropped,
    // so reload the buffer to recover from any display corruption.
    if (!this.activeSessionId || !this.terminal) return;
    // Skip if buffer load already in progress — avoids competing clear+rewrite cycles
    if (this._isLoadingBuffer) return;
    // COD-187: mirror tabs recover with a cheap frame refetch, never a history
    // replay. In history view the exit refetch covers it.
    if (this._isMirrorSession(this.activeSessionId)) {
      if (this._viewMode !== 'history') await this._refreshMirrorFrame(this.activeSessionId);
      return;
    }
    try {
      const activeSession = this.sessions.get(this.activeSessionId);
      // COD-189: shell recovery must use the FULL reload (capture-canonical) —
      // the byte-history tail is sparse after a fast burst (tmux jump-scroll
      // + the 128KB render-cap drops that triggered this very recovery), so a
      // tail refetch would faithfully reproduce the holes it should heal.
      // Claude keeps the fast tail (its byte history IS the conversation).
      const terminalUrl =
        activeSession?.mode === 'claude'
          ? `/api/sessions/${this.activeSessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`
          : `/api/sessions/${this.activeSessionId}/terminal`;
      const res = await fetch(terminalUrl);
      const data = (await res.json())?.data ?? {};
      if (data.terminalBuffer) {
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(data.terminalBuffer);
        this.terminal.scrollToBottom();
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
        // Resize PTY to match actual browser dimensions (critical for OpenCode
        // TUI sessions that render at fixed 120x40 until told the real size)
        if (this.activeSessionId) {
          this.sendResize(this.activeSessionId);
        }
      }
    } catch (err) {
      console.error('needsRefresh reload failed:', err);
    }
  }

  /**
   * COD-179: another client resized the shared PTY. Codex/gemini full-repaint at
   * the new geometry; if OUR xterm has different dims, those cursor-addressed
   * frames land misaligned and leave orphan rows (stale "Working" lines) in our
   * buffer. tmux itself stays clean, so a capture rewrite heals us. Debounced —
   * resize storms send several events; only the settled state matters. We do
   * NOT re-assert our own dims here: two live viewers would ping-pong resizes.
   */
  _onSessionResized(data) {
    if (data.id !== this.activeSessionId || !this.terminal) return;
    const session = this.sessions.get(data.id);
    if (session?.mode !== 'codex' && session?.mode !== 'gemini' && session?.mode !== 'agy') return;
    // Our own resize (or one that happens to match us) can't misalign our view.
    if (this.terminal.cols === data.cols && this.terminal.rows === data.rows) return;
    this._foreignResizeDirty = data.id;
    clearTimeout(this._foreignResizeTimer);
    this._foreignResizeTimer = setTimeout(() => {
      this._reconcileForeignResize(data.id);
    }, FOREIGN_RESIZE_SETTLE_MS);
  }

  /**
   * Rewrite the active terminal from the tmux capture (COD-179 foreign resize,
   * COD-180 idle/periodic remote reconcile). Only a canonical full-history
   * capture may REPLACE the terminal (`source === 'mux-full-history'`) — a
   * degraded response (remote ssh capture failed → one local screen, or raw
   * byte history) must never wipe accumulated scrollback. A repeat of the last
   * written buffer is skipped so a periodic tick with no changes is a no-op.
   */
  async _reconcileForeignResize(sessionId) {
    if (sessionId !== this.activeSessionId || !this.terminal) {
      // Tab switched — selectSession's own rewrite paints a clean state.
      this._foreignResizeDirty = null;
      return;
    }
    // COD-187: mirror tabs never replay history — a cheap frame refresh is the
    // repair for every trigger that lands here (foreign resize, idle, WS
    // reconnect). In history view the exit refetch heals instead.
    if (this._isMirrorSession(sessionId)) {
      this._foreignResizeDirty = null;
      if (this._viewMode !== 'history') await this._refreshMirrorFrame(sessionId);
      return;
    }
    // A buffer load is already repainting; keep the dirty flag so the idle
    // fallback re-checks later rather than racing two clear+rewrite cycles.
    if (this._isLoadingBuffer) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/terminal`);
      const data = (await res.json())?.data ?? {};
      if (sessionId !== this.activeSessionId || this._isLoadingBuffer) return;
      if (data.source !== 'mux-full-history') return;
      if (data.terminalBuffer) {
        if (this._lastReconcileWrite?.id === sessionId && this._lastReconcileWrite.buf === data.terminalBuffer) {
          this._foreignResizeDirty = null;
          return;
        }
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(data.terminalBuffer);
        this.terminal.scrollToBottom();
        this._localEchoOverlay?.rerender();
        this._lastReconcileWrite = { id: sessionId, buf: data.terminalBuffer };
        this._foreignResizeDirty = null;
      }
    } catch (err) {
      console.error('foreign-resize reconcile failed:', err);
    }
  }

  /** COD-182: any codex/gemini/agy tab — stale rows can appear locally too (reattach/reconnect churn). */
  _isTuiSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.mode === 'codex' || session?.mode === 'gemini' || session?.mode === 'agy';
  }

  /** COD-180: remote codex/gemini sessions — the live nested-tmux stream corrupts scrollback; reconcile heals it. */
  _isRemoteTuiSession(sessionId) {
    return this._isTuiSession(sessionId) && !!this.sessions.get(sessionId)?.remote;
  }

  /**
   * COD-187: live-mirror mode — agent-TUI tab with the per-device setting ON
   * (default). Includes claude (user opt-in expansion): mirror is purely a
   * client rendering mode, so claude's server-side stream parsing (tokens,
   * Ralph, prompt detection) is untouched. Deliberately NOT built on
   * _isTuiSession — that helper also gates LEGACY (setting-OFF) repair paths,
   * which must keep excluding claude exactly as before. COD-209: OpenCode is
   * deliberately excluded because its pure TUI owns the scrollable conversation
   * pane; Codeman history mode would intercept gestures the foreground app needs.
   */
  _isMirrorSession(sessionId) {
    return this._liveMirrorEnabled && this._isMirrorEligible(sessionId);
  }

  /** Modes the live mirror applies to when the setting is ON. */
  _isMirrorEligible(sessionId) {
    const mode = this.sessions.get(sessionId)?.mode;
    return mode === 'codex' || mode === 'gemini' || mode === 'claude';
  }

  /** COD-187: settings hook — flips the cached flag and re-selects the active TUI tab so the mode applies immediately. */
  _applyLiveMirrorSetting(enabled) {
    const on = enabled !== false; // default ON
    if (this._liveMirrorEnabled === on) return;
    this._liveMirrorEnabled = on;
    const id = this.activeSessionId;
    if (id && this._isMirrorEligible(id)) {
      this.selectSession(id, { forceReload: true });
    }
  }

  /**
   * COD-187: repaint a live-mirror tab's screen from the canonical frame
   * capture (`?frame=1` — cursor-positioned snapshot of the pane, remote-aware
   * server-side). This is the mirror-mode replacement for every full-history
   * repair path: idle, WS reconnect, foreign resize, needsRefresh,
   * clearTerminal. Single-flight, generation-guarded, deduped on content.
   */
  async _refreshMirrorFrame(sessionId) {
    if (sessionId !== this.activeSessionId || !this.terminal) return;
    if (!this._isMirrorSession(sessionId)) return;
    if (this._viewMode === 'history' || this._isLoadingBuffer) return;
    if (this._mirrorFrameInFlight) return;
    this._mirrorFrameInFlight = true;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/terminal?frame=1`);
      const data = (await res.json())?.data ?? {};
      if (sessionId !== this.activeSessionId || this._viewMode === 'history' || this._isLoadingBuffer) return;
      if (data.source !== 'mux-frame' || !data.terminalBuffer) return;
      if (this._lastMirrorFrame?.id === sessionId && this._lastMirrorFrame.buf === data.terminalBuffer) return;
      this.terminal.clear();
      this.terminal.reset();
      await this.chunkedTerminalWrite(data.terminalBuffer);
      this._localEchoOverlay?.rerender();
      this._lastMirrorFrame = { id: sessionId, buf: data.terminalBuffer };
    } catch (err) {
      console.error('mirror frame refresh failed:', err);
    } finally {
      this._mirrorFrameInFlight = false;
    }
  }

  /**
   * COD-187: open the frozen history view — raise scrollback, fetch the
   * canonical tmux full-history capture (remote-sourced for remote sessions,
   * COD-180) and freeze it under a pill. tmux copy-mode semantics.
   */
  /**
   * COD-190: speculative history prefetch — fired on the FIRST upward scroll
   * tick so the fetch (dominated by the ssh RTT on remote sessions) overlaps
   * the entry threshold instead of following it. Short TTL: the capture's
   * last screen must still match the live frame for the no-jump landing.
   */
  _prefetchHistory() {
    const id = this.activeSessionId;
    if (!id || !this._isMirrorSession(id) || this._viewMode !== 'live') return;
    if (this._historyPrefetch?.id === id && Date.now() - this._historyPrefetch.at < HISTORY_PREFETCH_TTL_MS) return;
    this._historyPrefetch = {
      id,
      at: Date.now(),
      promise: fetch(`/api/sessions/${id}/terminal?lines=${HISTORY_INITIAL_LINES}`)
        .then((r) => r.json())
        .catch(() => null),
    };
  }

  async _enterHistoryView(carryLines = 0) {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.terminal) return;
    if (!this._isMirrorSession(sessionId) || this._viewMode !== 'live') return;
    if (this._isLoadingBuffer) return;
    this._viewMode = 'history';
    this._historyMissedOutput = false;
    const gen = ++this._historyLoadGen;
    this._showHistoryPill('History — loading…');
    // COD-190 no-jump anchor: remember which viewport row the last non-empty
    // line sits on. The capture strips trailing blank rows, so "bottom of
    // buffer" lands HIGHER than the live frame — anchoring on content keeps
    // the entry pixel-stable instead.
    const preBuf = this.terminal.buffer.active;
    let anchorRow = -1;
    for (let r = this.terminal.rows - 1; r >= 0; r--) {
      if ((preBuf.getLine(preBuf.viewportY + r)?.translateToString(true) ?? '').trim()) {
        anchorRow = r;
        break;
      }
    }
    this.terminal.options.scrollback = this._userScrollback();
    try {
      // Fast first page (COD-187 lazy load): last HISTORY_INITIAL_LINES lines.
      // Prefer the speculative prefetch (COD-190) started on the first
      // up-tick; single-use — consume and clear.
      const prefetch =
        this._historyPrefetch?.id === sessionId && Date.now() - this._historyPrefetch.at < HISTORY_PREFETCH_TTL_MS
          ? this._historyPrefetch.promise
          : null;
      this._historyPrefetch = null;
      const json = await (prefetch ?? fetch(`/api/sessions/${sessionId}/terminal?lines=${HISTORY_INITIAL_LINES}`).then((r) => r.json()));
      const data = json?.data ?? {};
      if (gen !== this._historyLoadGen || sessionId !== this.activeSessionId || this._viewMode !== 'history') return;
      if (data.source !== 'mux-full-history' || !data.terminalBuffer) {
        this.showToast?.('History unavailable for this session', 'warning');
        this._exitHistoryView();
        return;
      }
      this._historyPartial = data.historyPartial === true;
      // COD-190 atomic swap: ONE write wrapped in DEC 2026 synchronized-update
      // markers — xterm 6 holds rendering until the terminator, so the blank
      // clear frame never paints. Embedded 2026 markers are stripped from the
      // content so they can't terminate our window early. No terminal.reset()
      // here (it would drop sync mode); \x1b[3J\x1b[H\x1b[2J clears
      // scrollback + screen in place.
      const owner = this._beginBufferLoad(`history-${gen}`);
      const content = data.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
      await new Promise((resolve) => this.terminal.write(`\x1b[?2026h\x1b[3J\x1b[H\x1b[2J${content}\x1b[?2026l`, resolve));
      this._finishBufferLoad(owner);
      if (gen !== this._historyLoadGen || this._viewMode !== 'history') return;
      // COD-190 no-jump landing: place the history's last non-empty line on
      // the SAME viewport row it occupied in the live frame (content-anchored
      // — the capture trims trailing blanks, so plain scrollToBottom would
      // shift everything up). Then apply the user's accumulated wheel delta
      // so their own gesture carries them up into history smoothly.
      const nb = this.terminal.buffer.active;
      let lastContent = -1;
      for (let i = nb.baseY + this.terminal.rows - 1; i >= 0; i--) {
        if ((nb.getLine(i)?.translateToString(true) ?? '').trim()) {
          lastContent = i;
          break;
        }
      }
      if (anchorRow >= 0 && lastContent >= 0) {
        this.terminal.scrollToLine(Math.max(0, Math.min(nb.baseY, lastContent - anchorRow)));
      } else {
        this.terminal.scrollToBottom();
      }
      if (carryLines > 0) this.terminal.scrollLines(-carryLines);
      this._updateHistoryPill();
    } catch (err) {
      console.error('history view load failed:', err);
      if (gen === this._historyLoadGen && this._viewMode === 'history') this._exitHistoryView();
    }
  }

  /**
   * COD-187 lazy load: the user hit the top of the partial history — replace
   * it with the unbounded capture, preserving the reading position (anchored
   * by distance from the bottom, which both captures share).
   */
  async _expandHistoryFull() {
    const sessionId = this.activeSessionId;
    if (!sessionId || this._viewMode !== 'history' || !this._historyPartial) return;
    if (this._historyExpandInFlight) return;
    this._historyExpandInFlight = true;
    const gen = this._historyLoadGen;
    this._showHistoryPill('History — loading older…');
    try {
      const res = await fetch(`/api/sessions/${sessionId}/terminal?capture=1`);
      const data = (await res.json())?.data ?? {};
      if (gen !== this._historyLoadGen || this._viewMode !== 'history') return;
      if (data.source !== 'mux-full-history' || !data.terminalBuffer) {
        this._historyPartial = false;
        this._updateHistoryPill();
        return;
      }
      const bufBefore = this.terminal.buffer.active;
      const distFromBottom = bufBefore.baseY - bufBefore.viewportY;
      const owner = this._beginBufferLoad(`history-${gen}-full`);
      this._resetTerminalForReplay();
      await this.chunkedTerminalWrite(data.terminalBuffer, TERMINAL_CHUNK_SIZE, owner);
      if (gen !== this._historyLoadGen || this._viewMode !== 'history') return;
      this._historyPartial = false;
      const buf = this.terminal.buffer.active;
      this.terminal.scrollToLine(Math.max(0, buf.baseY - distFromBottom));
      this._updateHistoryPill();
    } catch (err) {
      console.error('history expand failed:', err);
    } finally {
      this._historyExpandInFlight = false;
    }
  }

  /** COD-187: leave history — trim scrollback back to 0 and repaint the live frame. */
  _exitHistoryView() {
    if (this._viewMode !== 'history') return;
    this._viewMode = 'live';
    this._historyLoadGen++;
    this._historyMissedOutput = false;
    this._historyPartial = false;
    this._historyExitAt = Date.now();
    this._hideHistoryPill();
    // Stale sticky-scroll grace must not survive into live mode.
    this._lastUserScrollUpAt = null;
    if (this.terminal && this.activeSessionId && this._isMirrorSession(this.activeSessionId)) {
      this.terminal.options.scrollback = 0; // trims the freeze-frame instantly
      this._lastMirrorFrame = null; // force the repaint even if the frame text matches
      this._refreshMirrorFrame(this.activeSessionId);
    }
  }

  _showHistoryPill(text) {
    const pill = document.getElementById('historyPill');
    if (!pill) return;
    pill.textContent = text;
    pill.hidden = false;
  }

  _updateHistoryPill() {
    if (this._viewMode !== 'history') return;
    let base = 'History (frozen) — Esc or scroll to bottom to resume';
    if (this._historyPartial) base += ' · scroll to top for older';
    this._showHistoryPill(this._historyMissedOutput ? `${base} · new output below` : base);
  }

  _hideHistoryPill() {
    const pill = document.getElementById('historyPill');
    if (pill) pill.hidden = true;
  }

  /**
   * COD-180: periodic mid-turn reconcile for busy REMOTE TUI sessions. Their
   * live stream is nested-tmux repaint traffic that mangles what lands in
   * browser scrollback (lost table rows, partial frames); a capture rewrite
   * every tick bounds any corruption's lifetime to ~25s. Skipped unless the
   * user is parked at the bottom (never yank someone reading scrollback); an
   * unchanged capture is a no-op via the compare in _reconcileForeignResize.
   */
  _remoteReconcileTick() {
    const id = this.activeSessionId;
    if (!id || !this.terminal || this._isLoadingBuffer) return;
    if (this._isMirrorSession(id)) return; // COD-187: superseded — the live screen self-heals every repaint
    if (!this._isRemoteTuiSession(id)) return;
    // Deliberately NOT gated on busy status: remote codex sessions often never
    // flip to busy (their "Working (…)" frames arrive as partial cell updates
    // split across chunks, defeating the working-state match — see COD-180
    // notes), and an unchanged capture makes an idle tick a cheap no-op via
    // the content-compare in _reconcileForeignResize.
    const buf = this.terminal.buffer.active;
    if (buf.viewportY !== buf.baseY) return; // scrolled up — don't yank
    this._reconcileForeignResize(id);
  }

  async _onSessionClearTerminal(data) {
    if (data.id === this.activeSessionId) {
      // COD-187: mirror tabs repaint from the frame capture instead of a
      // history replay (in history view, exit refetches).
      if (this._isMirrorSession(data.id)) {
        if (this._viewMode !== 'history' && !this._isLoadingBuffer) {
          this._lastMirrorFrame = null; // pane was cleared — force the rewrite
          await this._refreshMirrorFrame(data.id);
        }
        return;
      }
      // Skip if selectSession is already loading the buffer — clearTerminal arriving
      // during buffer load would clear the terminal mid-write, causing visible flicker
      // and a race between two concurrent chunkedTerminalWrite calls (especially on mobile
      // where rAF is slower). selectSession will handle the final buffer state.
      if (this._isLoadingBuffer) return;

      // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
      try {
        const res = await fetch(`/api/sessions/${data.id}/terminal`);
        const termData = (await res.json())?.data ?? {};

        this.terminal.clear();
        this.terminal.reset();
        if (termData.terminalBuffer) {
          // Strip any DEC 2026 markers and write raw content
          // (markers don't help here - this is a static buffer reload, not live Ink redraws)
          const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
          // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
          await this.chunkedTerminalWrite(cleanBuffer);
        }

        // Fire-and-forget resize — don't block on it
        this.sendResize(data.id);
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
      } catch (err) {
        console.error('clearTerminal refresh failed:', err);
      }
    }
  }

  _onSessionCompletion(data) {
    this.totalCost += data.cost || 0;
    this.updateCost();
    if (data.id === this.activeSessionId) {
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
    }
  }

  _onSessionError(data) {
    if (data.id === this.activeSessionId) {
      this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
    }
    this._notifySession(data.id, 'critical', 'session-error', 'Session Error', data.error || 'Unknown error');
  }

  _onSessionExit(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'stopped';
      this.renderSessionTabs();
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Notify on unexpected exit (non-zero code)
    if (data.code && data.code !== 0) {
      this._notifySession(data.id, 'critical', 'session-crash', 'Session Crashed', `Exited with code ${data.code}`);
    }
  }

  _onSessionIdle(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'idle';
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // COD-179: a foreign resize dirtied this view mid-turn — later repaints may
    // have re-corrupted it after the debounced rewrite. COD-180/182: ALL TUI
    // tabs (remote AND local codex/gemini) reconcile on idle — remote live
    // streams are nested-tmux repaint traffic that corrupts scrollback, and
    // local tabs pick up stale rows from reattach/reconnect churn (COD-182:
    // duplicated composer placeholder after a deploy restart). Turn end is the
    // stable point to swap in the canonical capture; an unchanged capture is
    // a no-op via the content compare.
    if (data.id === this.activeSessionId && (this._foreignResizeDirty === data.id || this._isTuiSession(data.id))) {
      clearTimeout(this._foreignResizeTimer);
      this._foreignResizeTimer = setTimeout(() => {
        this._reconcileForeignResize(data.id);
      }, TUI_REDRAW_SETTLE_MS);
    }
    // Start stuck detection timer (only if no respawn running)
    if (!this.respawnStatus[data.id]?.enabled) {
      const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
      clearTimeout(this.idleTimers.get(data.id));
      this.idleTimers.set(data.id, setTimeout(() => {
        this._notifySession(data.id, 'warning', 'session-stuck', 'Session Idle', `Idle for ${Math.round(threshold / 60000)}+ minutes`);
        this.idleTimers.delete(data.id);
      }, threshold));
    }
  }

  _onSessionWorking(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'busy';
      // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
      if (!this.pendingHooks.has(data.id)) {
        this.tabAlerts.delete(data.id);
      }
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Clear stuck detection timer
    const timer = this.idleTimers.get(data.id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(data.id);
    }
  }

  _onSessionAutoClear(data) {
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
      this.updateRespawnTokens(0);
    }
    this._notifySession(data.sessionId, 'info', 'auto-clear', 'Auto-Cleared', `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`);
  }

  _onSessionLimitPauseScheduled(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = data.resumeAt;
    const at = new Date(data.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Usage limit reached — auto-resume at ${at}`, 'warning');
    }
    this._notifySession(data.sessionId, 'warning', 'limit-pause', 'Usage Limit Reached', `Auto-resume scheduled for ${at}`);
    this.updateAutoResumeStatus(data.sessionId);
  }

  _onSessionLimitResume(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = undefined;
    if (data.sessionId === this.activeSessionId) {
      this.showToast('Usage limit reset — work resumed automatically', 'success');
    }
    this._notifySession(data.sessionId, 'info', 'limit-resume', 'Auto-Resumed', 'Usage limit reset — continuing work');
    this.updateAutoResumeStatus(data.sessionId);
  }

  _onSessionLimitResumeCancelled(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = undefined;
    this.updateAutoResumeStatus(data.sessionId);
  }

  // COD-118: the interactive PTY exit circuit breaker tripped (repeated non-zero exits).
  // The errored status itself arrives via session:updated; this just surfaces a toast for
  // diagnostic clarity so a silently-looping session is obvious. Restart clears the breaker.
  _onSessionRespawnBreakerTripped(data) {
    const session = this.sessions.get(data.sessionId);
    const label = session?.name || 'Session';
    this.showToast?.(`${label} stopped: repeated crashes detected. Restart to retry.`, 'error');
  }

  _onSessionCliInfo(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) {
      if (data.version) session.cliVersion = data.version;
      if (data.model) session.cliModel = data.model;
      if (data.accountType) session.cliAccountType = data.accountType;
      if (data.latestVersion) session.cliLatestVersion = data.latestVersion;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateCliInfoDisplay();
    }
  }

  // Claude plan usage limits (5-hour + weekly) — account-global, so the latest
  // sample from any session drives the shared header chip.
  _onSessionStatusTelemetry(data) {
    this.updatePlanUsageChip(data);
    // Persist last-known so the chip shows immediately on the next page load /
    // SSE reconnect, instead of staying blank until a session next renders.
    try {
      localStorage.setItem('codeman:planUsage', JSON.stringify({ t: Date.now(), data }));
    } catch {}
  }

  // Repopulate the chip from the last-known value on page load (account-global,
  // slow-moving; ignored if older than 12h). Live events refresh it.
  restorePlanUsageChip() {
    try {
      const raw = localStorage.getItem('codeman:planUsage');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.data && Date.now() - (saved.t || 0) < 12 * 3600 * 1000) {
        this.updatePlanUsageChip(saved.data);
      }
    } catch {}
  }

  updatePlanUsageChip(data) {
    const chip = document.getElementById('planUsageChip');
    if (!chip || !data) return;
    const pct = (w) => (w && typeof w.usedPercentage === 'number' ? Math.round(w.usedPercentage) : null);
    const five = pct(data.fiveHour);
    const seven = pct(data.sevenDay);
    if (five === null && seven === null) return;
    // Per-window color by how much is used up: green < 60%, yellow 60–84%, red ≥ 85%.
    const colorClass = (p) => (p >= 85 ? 'pu-red' : p >= 60 ? 'pu-yellow' : 'pu-green');
    // innerHTML here is XSS-safe ONLY because every interpolated value is a
    // coerced finite number and the labels/classes are fixed literals. If a
    // string field (e.g. modelDisplayName, which the route also broadcasts) is
    // ever shown in this chip, render it via textContent — never interpolate an
    // untrusted string into this template.
    const seg = (label, p) => {
      if (p === null) return '';
      const n = Math.round(Number(p));
      if (!Number.isFinite(n)) return '';
      return `<span class="pu-win"><span class="pu-label">${label}</span><span class="pu-val ${colorClass(n)}">${n}%</span></span>`;
    };
    chip.innerHTML = [seg('5h', five), seg('7d', seven)].filter(Boolean).join('<span class="pu-sep">·</span>');
    const resetStr = (w) => (w && w.resetAt ? new Date(w.resetAt).toLocaleString() : '—');
    chip.title =
      `Claude plan usage\n` +
      `5-hour limit: ${five ?? '—'}% used (resets ${resetStr(data.fiveHour)})\n` +
      `Weekly limit: ${seven ?? '—'}% used (resets ${resetStr(data.sevenDay)})`;
  }

  // Scheduled runs
  _onScheduledCreated(data) {
    this.currentRun = data;
    this.showTimer();
  }

  _onScheduledUpdated(data) {
    this.currentRun = data;
    this.updateTimer();
  }

  _onScheduledCompleted(data) {
    this.currentRun = data;
    this.hideTimer();
    this.showToast('Scheduled run completed!', 'success');
  }

  _onScheduledStopped() {
    this.currentRun = null;
    this.hideTimer();
  }

  // ═══════════════════════════════════════════════════════════════
  // Connection Status, Input Queuing & State Initialization
  // ═══════════════════════════════════════════════════════════════

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._updateConnectionIndicator();
    if (status === 'connected') {
      // Reconnected (SSE) — push any durably-queued input out immediately
      // instead of waiting for the next 2s sweep.
      this._redeliverSweep();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WebSocket Terminal I/O
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a WebSocket for terminal I/O on the given session.
   * Replaces HTTP POST input and SSE terminal output with a single
   * bidirectional connection. Falls back to SSE+POST if WS fails.
   */
  _connectWs(sessionId) {
    this._disconnectWs();
    this._wsState = 'connecting';
    this._updateConnectionIndicator();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Scope registry identity per tab: reconnects from this tab supersede their
    // own socket, while two tabs sharing the browser-wide clientId can coexist.
    // Input frames keep the bare clientId for durable sequence deduplication.
    const cid = this._clientId ? `${this._clientId}:${this._wsTabNonce}` : '';
    const cidQuery = cid ? `?cid=${encodeURIComponent(cid)}` : '';
    const url = `${proto}//${location.host}/ws/sessions/${sessionId}/terminal${cidQuery}`;
    const ws = new WebSocket(url);
    this._ws = ws;
    this._wsSessionId = sessionId;
    this._wsReady = false;
    this._wsState = 'connecting';
    this._updateConnectionIndicator();

    ws.onopen = () => {
      // Only mark ready if this is still the intended session
      if (this._ws === ws) {
        this._wsReady = true;
        this._wsState = 'connected';
        // COD-182: a RECONNECT (attempts > 0) means the server or link dropped
        // mid-session — the reattach/redraw churn in that window leaves stale
        // rows in TUI tabs (e.g. duplicated composer placeholder after a
        // deploy restart). Schedule a one-shot capture reconcile once output
        // settles. First-connects skip this: selectSession just painted.
        const wasReconnect = this._wsReconnectAttempts > 0;
        this._wsReconnectAttempts = 0;
        this._updateConnectionIndicator();
        if (wasReconnect && this._isTuiSession(sessionId)) {
          clearTimeout(this._foreignResizeTimer);
          this._foreignResizeTimer = setTimeout(() => {
            this._reconcileForeignResize(sessionId);
          }, FOREIGN_RESIZE_SETTLE_MS);
        }
        // Send a typed resize over the fresh socket: syncs PTY dims after
        // (re)connects AND registers the desktop sizing claim server-side —
        // selectSession's earlier resizes ran before this WS existed, so they
        // went over HTTP, which never claims (see ws-routes sizingToken).
        this.sendResize(sessionId)?.catch?.(() => {});
        this._startMobileResizeRetry(sessionId);
        // Flush any durably-queued input over the fresh socket (covers frames a
        // prior half-open socket silently dropped, and input typed while offline).
        this._onWsReady(sessionId);
      }
    };

    ws.onmessage = (event) => {
      if (this._ws !== ws) return;
      // Mark the socket as alive on every received frame (output, ACK, etc.) so
      // the redeliver sweep only force-closes a genuinely silent connection.
      this._wsLastRecvAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.t === 'o') {
          // Terminal output — route through the same batching pipeline as SSE
          this._onSessionTerminal({ id: sessionId, data: msg.d });
        } else if (msg.t === 'c') {
          this._onSessionClearTerminal({ id: sessionId });
        } else if (msg.t === 'r') {
          this._onSessionNeedsRefresh({ id: sessionId });
        } else if (msg.t === 'ia') {
          // Input ACK — the server applied (or deduped) this seq; drop it from
          // the durable queue so it can never be re-delivered/lost.
          this._onWsInputAck(msg.seq);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;
      this._wsLastClose = {
        code: event.code,
        reason: event.reason || '',
        at: new Date().toISOString(),
      };
      this._stopMobileResizeRetry();

      // Decide what to do next from the close code + how many consecutive
      // reconnects we've already made (pure policy in constants.js):
      //   reconnect      → transient (server restart, network blip, ping timeout);
      //                    schedule a backoff retry while this session stays active.
      //   retry-fallback → too-many-connections / unknown rejection; show the HTTP
      //                    fallback but keep retrying so we return to WS when it clears.
      //   give-up        → 4004 (not found) / 4009 (terminated); the session is gone.
      // _disconnectWs() nulls onclose for intentional disconnects, so we never land here for those.
      const plan = window.CodemanWsReconnect.plan(event.code, this._wsReconnectAttempts || 0);
      _crashDiag.log(
        `WS CLOSE code=${event.code} reason=${event.reason || ''} action=${plan.action} attempts=${this._wsReconnectAttempts || 0}`
      );

      const stillActive = this.activeSessionId === sessionId;
      if (stillActive && plan.action !== 'give-up') {
        this._scheduleWsCloseRefresh(sessionId);
      }
      if (plan.action === 'give-up') {
        this._wsState = stillActive ? 'fallback' : 'disconnected';
        this._updateConnectionIndicator();
      } else if (plan.action === 'reconnect') {
        if (stillActive) {
          this._wsState = 'reconnecting';
          this._updateConnectionIndicator();
          const delay = plan.delayMs + Math.floor(Math.random() * 250); // jitter to de-sync herds
          this._wsReconnectAttempts = (this._wsReconnectAttempts || 0) + 1;
          this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            if (this.activeSessionId === sessionId) {
              this._connectWs(sessionId);
            }
          }, delay);
        } else {
          this._wsState = 'disconnected';
          this._updateConnectionIndicator();
        }
      } else {
        // retry-fallback: surface the HTTP fallback, but keep trying on a bounded
        // timer so the transport returns to WS once the transient condition clears.
        this._wsState = stillActive ? 'fallback' : 'disconnected';
        this._updateConnectionIndicator();
        if (stillActive) {
          this._wsReconnectAttempts = (this._wsReconnectAttempts || 0) + 1;
          this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            if (this.activeSessionId === sessionId) {
              this._connectWs(sessionId);
            }
          }, plan.delayMs);
        }
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — cleanup happens there
    };
  }

  _scheduleWsCloseRefresh(sessionId) {
    this._clearTimer('_wsCloseRefreshTimer');
    this._wsCloseRefreshTimer = setTimeout(() => {
      this._wsCloseRefreshTimer = null;
      if (this.activeSessionId === sessionId) {
        this._onSessionNeedsRefresh({ id: sessionId });
      }
    }, 250);
  }

  /** Close the active WebSocket connection (if any). */
  _disconnectWs() {
    this._clearTimer('_wsReconnectTimer');
    // Deliberately do NOT reset _wsReconnectAttempts here: _connectWs() calls
    // this first, so a reset would restart the exponential backoff ladder at
    // attempt 0 on every retry (≈0ms tight reconnect loop during an outage).
    // ws.onopen zeroes the counter once a connection actually succeeds.
    this._wsState = 'disconnected';
    this._stopMobileResizeRetry();
    if (this._ws) {
      this._ws.onclose = null; // Prevent re-entrant cleanup
      this._ws.close();
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;
      this._wsState = 'disconnected';
      this._updateConnectionIndicator();
    }
  }

  /**
   * Small-viewport claim-idle retry. While a desktop sizing claim is "hot",
   * the server ignores this device's resize (Session.DESKTOP_CLAIM_IDLE_MS),
   * and the single resize sent on attach is deduped client-side — without a
   * retry, a phone that attached under an active desktop would render a
   * desktop-width stream forever. Re-send the current dims periodically (a
   * server-side no-op once the pane already matches) so the pane reflows to
   * this device shortly after the desktop goes idle. Visible-tab only: a
   * phone in a pocket must not steal the pane from an active desktop.
   */
  _startMobileResizeRetry(sessionId) {
    this._stopMobileResizeRetry();
    const type =
      typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
        ? MobileDetection.getDeviceType()
        : 'desktop';
    if (type === 'desktop') return;
    this._mobileResizeRetryTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!this._wsReady || this._wsSessionId !== sessionId) return;
      // Same guard as throttledResize: while the virtual keyboard is up, a
      // fit()+SIGWINCH at the shrunken row count makes Ink re-render garbage
      // and shifts the accessory toolbar mid-typing. Retry after it closes.
      if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) return;
      this.sendResize(sessionId)?.catch?.(() => {});
    }, MOBILE_RESIZE_RETRY_MS);
  }

  _stopMobileResizeRetry() {
    if (this._mobileResizeRetryTimer) {
      clearInterval(this._mobileResizeRetryTimer);
      this._mobileResizeRetryTimer = null;
    }
  }

  /**
   * Public input entry point — name/signature kept for all call sites.
   * Records the input durably, then delivers it reliably (exactly-once). Never
   * blocks the keystroke flush; never silently drops on a half-open socket.
   * @param {string} sessionId
   * @param {string} input
   * @param {{useMux?: boolean}} [opts] - useMux only affects the POST fallback.
   */
  _sendInputAsync(sessionId, input, opts) {
    if (!sessionId || !input) return;
    this._reliableSend(sessionId, input, opts?.useMux === true);
  }

  /**
   * Fire-and-forget input for EPHEMERAL, loss-tolerant streams (e.g. wheel-scroll
   * reports). Unlike _sendInputAsync, this never enters the durable seq/ACK queue,
   * so it isn't persisted, retried, or counted in the pending-bytes connection
   * indicator (which was flickering "11b/22b queued" on every scroll tick). A
   * dropped scroll tick is harmless; keystrokes still go through _sendInputAsync.
   * The server applies a seq-less {t:'i'} frame / seq-less POST unconditionally
   * and sends no ACK (ws-routes.ts, session-routes input handler).
   */
  _sendInputEphemeral(sessionId, input) {
    if (!sessionId || !input) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
      try {
        this._ws.send(JSON.stringify({ t: 'i', d: input }));
        return;
      } catch {
        // socket died mid-send — fall through to a best-effort POST
      }
    }
    // No usable WS for this session: best-effort POST, not queued. Dropped on
    // failure — a scroll tick lost while offline needs no recovery.
    try {
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // ignore — loss-tolerant
    }
  }

  /** Record one input frame and kick delivery. The record lives until ACKed. */
  _reliableSend(sessionId, data, useMux) {
    const seq = this._nextSeq(sessionId);
    const rec = { seq, data, useMux: !!useMux, ts: Date.now(), tries: 0, sentAt: 0 };
    let list = this._pendingDeliveries.get(sessionId);
    if (!list) {
      list = [];
      this._pendingDeliveries.set(sessionId, list);
    }
    list.push(rec);
    this._persistReliableState();
    this._updateConnectionIndicator();
    this._drainSession(sessionId);
  }

  _nextSeq(sessionId) {
    const next = (this._seqCounters.get(sessionId) || 0) + 1;
    this._seqCounters.set(sessionId, next);
    return next;
  }

  /** Deliver all unacked records for a session, in seq order. */
  _drainSession(sessionId) {
    const list = this._pendingDeliveries.get(sessionId);
    if (!list || list.length === 0) return;

    // Fast path: WebSocket open for this session — fire each not-yet-sent record
    // over the single ordered stream. They stay pending until the server ACKs
    // them ({t:'ia'}); a frame swallowed by a half-open socket is re-sent after
    // the sweep force-reconnects (which resets sentAt=0 in _onWsReady).
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
      for (const rec of list) {
        if (rec.sentAt !== 0) continue;
        try {
          this._ws.send(JSON.stringify({ t: 'i', d: rec.data, seq: rec.seq, cid: this._clientId }));
          rec.sentAt = Date.now();
          rec.tries++;
        } catch {
          break; // socket died mid-send — reconnect/POST drainer retries
        }
      }
      return;
    }

    // Slow path: no WS — POST records in order, awaiting each (the HTTP 2xx is
    // the ACK). Serialized per session so seq order survives async fetches.
    if (this._postDraining.has(sessionId)) return;
    this._postDraining.add(sessionId);
    (async () => {
      try {
        for (;;) {
          const cur = this._pendingDeliveries.get(sessionId);
          if (!cur || cur.length === 0) break;
          // If the WebSocket came back mid-drain, yield to it (the acked stream)
          // so we don't redundantly re-POST what onopen is already re-sending.
          if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
            break;
          }
          const rec = cur[0];
          rec.tries++;
          rec.sentAt = Date.now();
          let resp = null;
          try {
            const body = { input: rec.data, seq: rec.seq, clientId: this._clientId };
            if (rec.useMux) body.useMux = true;
            resp = await fetch(`/api/sessions/${sessionId}/input`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              keepalive: rec.data.length < 65536,
            });
          } catch {
            resp = null;
          }
          if (resp && resp.ok) {
            this._ackDelivery(sessionId, rec.seq);
          } else if (resp && (resp.status === 404 || resp.status === 410)) {
            // Session no longer exists — the input can never land. Drop it
            // rather than retry forever (not a "lost" prompt: the target is gone).
            this._ackDelivery(sessionId, rec.seq);
          } else {
            break; // offline / 5xx — leave queued; sweep + reconnect retry later
          }
        }
      } finally {
        this._postDraining.delete(sessionId);
      }
    })();
  }

  /** Drop an ACKed record (by exact seq) and persist. */
  _ackDelivery(sessionId, seq) {
    const list = this._pendingDeliveries.get(sessionId);
    if (list) {
      const idx = list.findIndex((r) => r.seq === seq);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this._pendingDeliveries.delete(sessionId);
        // When nothing is left pending anywhere, flush durable state immediately
        // (not debounced) so a reload in the next 250ms can't redeliver an
        // already-delivered frame — otherwise localStorage briefly still shows it.
        if (this._pendingDeliveries.size === 0) this._persistReliableNow();
        else this._persistReliableState();
        this._updateConnectionIndicator();
      }
    }
    this.clearPendingHooks?.(sessionId);
  }

  /** Server input-ACK frame ({t:'ia',seq}) over the WebSocket. */
  _onWsInputAck(seq) {
    if (this._wsSessionId && Number.isInteger(seq)) this._ackDelivery(this._wsSessionId, seq);
  }

  /** Called from ws.onopen — flush everything pending over the fresh socket. */
  _onWsReady(sessionId) {
    const list = this._pendingDeliveries.get(sessionId);
    if (list) for (const r of list) r.sentAt = 0; // fresh socket ⇒ re-send all
    this._drainSession(sessionId);
  }

  /**
   * Periodic retry. For the active WS session, an oldest frame unacked past the
   * timeout means the socket is (half-)dead — close it to force a fast reconnect
   * (onclose → reconnect → onopen → _onWsReady re-sends). Other sessions just
   * (re)drain over POST.
   */
  _redeliverSweep() {
    if (this._pendingDeliveries.size === 0) return;
    for (const sessionId of [...this._pendingDeliveries.keys()]) {
      const list = this._pendingDeliveries.get(sessionId);
      if (!list || list.length === 0) continue;
      const isActiveWs =
        this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId;
      if (isActiveWs) {
        const oldest = list[0];
        // Only tear the socket down when the oldest unacked frame is stale AND the
        // socket has been silent for the timeout: a connection still delivering
        // output/ACKs is alive (the ACK is just behind), so force-closing it would
        // cause needless WS↔HTTP flapping. A truly half-open socket goes quiet.
        const stale = oldest && oldest.sentAt && Date.now() - oldest.sentAt > this._reliableAckTimeoutMs;
        const silent = Date.now() - this._wsLastRecvAt > this._reliableAckTimeoutMs;
        if (stale && silent) {
          try {
            this._ws.close(); // half-open: never recovers on its own — force reconnect
          } catch {
            /* ignore */
          }
          continue;
        }
        if (stale) {
          // Stale but the socket is still delivering output: the ACK was lost,
          // not the connection. Force-closing isn't warranted (the link is fine),
          // but the fast path skips anything with sentAt!==0, so the stranded
          // frame would never re-send. Reset sentAt=0 on every stale unacked
          // frame so the _drainSession below re-drives them over the live socket
          // (server dedups by seq, so a re-sent lost-ACK frame is harmless).
          // Frames sent recently (not yet stale) are left untouched.
          for (const rec of list) {
            if (rec.sentAt && Date.now() - rec.sentAt > this._reliableAckTimeoutMs) rec.sentAt = 0;
          }
        }
      }
      this._drainSession(sessionId);
    }
  }

  /** Total bytes/count still awaiting ACK across all sessions (for the indicator). */
  _pendingBytes() {
    let bytes = 0;
    let count = 0;
    for (const list of this._pendingDeliveries.values()) {
      for (const r of list) {
        bytes += r.data.length;
        count++;
      }
    }
    return { bytes, count };
  }

  // ---- durable persistence (localStorage; quota- and disabled-storage-safe) --

  _loadReliableState() {
    // Stable client identity for server-side dedup across reconnects/reloads.
    try {
      this._clientId = localStorage.getItem('codeman:clientId') || '';
    } catch {
      this._clientId = '';
    }
    if (!this._clientId) {
      this._clientId = 'c-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      try {
        localStorage.setItem('codeman:clientId', this._clientId);
      } catch {
        /* storage disabled — dedup degrades to per-load, still no loss */
      }
    }
    try {
      const raw = localStorage.getItem('codeman:pendingInput');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && saved.seqs) {
        for (const [s, n] of Object.entries(saved.seqs)) {
          if (Number.isFinite(n)) this._seqCounters.set(s, n);
        }
      }
      if (saved && saved.pending) {
        for (const [s, recs] of Object.entries(saved.pending)) {
          if (Array.isArray(recs) && recs.length) {
            // Reset sentAt so they re-deliver promptly on this fresh load.
            this._pendingDeliveries.set(
              s,
              recs
                .filter((r) => r && typeof r.data === 'string' && Number.isInteger(r.seq))
                .map((r) => ({
                  seq: r.seq,
                  data: r.data,
                  useMux: !!r.useMux,
                  ts: r.ts || Date.now(),
                  tries: 0,
                  sentAt: 0,
                }))
            );
          }
        }
      }
    } catch {
      /* corrupt/parse error — start clean rather than throw */
    }
  }

  _persistReliableState() {
    // Debounced — typing without local echo calls this per keystroke.
    if (this._persistReliableTimer) return;
    this._persistReliableTimer = setTimeout(() => {
      this._persistReliableTimer = null;
      this._persistReliableNow();
    }, 250);
  }

  _persistReliableNow() {
    if (this._persistReliableTimer) {
      clearTimeout(this._persistReliableTimer);
      this._persistReliableTimer = null;
    }
    try {
      const seqs = {};
      for (const [s, n] of this._seqCounters) seqs[s] = n;
      const pending = {};
      let bytes = 0;
      for (const [s, list] of this._pendingDeliveries) {
        if (!list.length) continue;
        pending[s] = list.map((r) => ({
          seq: r.seq,
          data: r.data,
          useMux: r.useMux,
          ts: r.ts,
          tries: r.tries,
        }));
        for (const r of list) bytes += r.data.length;
      }
      // Bound the persisted backlog. On extreme overflow keep the seq counters
      // (so future input stays monotonic and dedup-safe) but skip the payloads —
      // the in-memory queue still delivers; only cross-reload durability is lost.
      const payload =
        bytes > this._reliableMaxBytes ? { seqs } : { seqs, pending };
      localStorage.setItem('codeman:pendingInput', JSON.stringify(payload));
    } catch {
      /* QuotaExceeded or disabled storage — in-memory delivery is unaffected */
    }
  }

  // Pure render of the header connection indicator: reads only `this.*` state,
  // touches NO DOM. Returns the exact { display, dotClass, text, title } tuple the
  // writer applies. When hidden (display:'none') the other three are normalized to
  // '' so the cache compare in _updateConnectionIndicator() is well-defined.
  // Every branch/string here must stay byte-identical to what's rendered today.
  _computeConnectionDescriptor() {
    const { bytes: totalBytes, count } = this._pendingBytes();
    const hasQueue = count > 0;
    // Only surface a backlog once it's more than a few bytes. A single keystroke
    // (1B) ACKs in milliseconds, so without this the label flickered "sending 1B"
    // on every key press. Above this threshold means input is genuinely backing up.
    const BACKLOG_HINT_BYTES = 4;
    const showBacklog = totalBytes > BACKLOG_HINT_BYTES;
    const formatBytes = (b) => (b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`);
    const queuedSuffix = showBacklog ? ` · ${formatBytes(totalBytes)} queued` : '';

    // Hard offline (browser reports no network) dominates everything.
    if (!this.isOnline || this._connectionStatus === 'offline') {
      return {
        display: 'flex',
        dotClass: 'connection-dot offline',
        text: showBacklog ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline',
        title: 'No network connection',
      };
    }

    // With an active terminal, show its transport (WebSocket vs HTTP fallback).
    if (this.activeSessionId) {
      let cls, label, detail;
      switch (this._wsState) {
        case 'connected':
          cls = 'connected'; label = 'WS'; detail = 'Terminal connected over WebSocket';
          break;
        case 'fallback':
          cls = 'fallback'; label = 'HTTP'; detail = 'WebSocket unavailable — input sent over HTTP';
          break;
        case 'reconnecting':
          cls = 'reconnecting'; label = 'WS…'; detail = 'Reconnecting WebSocket';
          break;
        case 'connecting':
        default:
          cls = 'reconnecting'; label = 'WS…'; detail = 'Connecting WebSocket';
          break;
      }
      return {
        display: 'flex',
        dotClass: `connection-dot ${cls}`,
        text: `${label}${queuedSuffix}`,
        title: detail,
      };
    }

    // No active terminal — reflect the SSE event stream only when it needs attention.
    if (this._connectionStatus === 'reconnecting' || this._connectionStatus === 'disconnected') {
      return {
        display: 'flex',
        dotClass: 'connection-dot reconnecting',
        text: showBacklog ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...',
        title: 'Reconnecting to server',
      };
    }

    // Idle dashboard, healthy stream — hide unless input is genuinely queued.
    if (!hasQueue) {
      return { display: 'none', dotClass: '', text: '', title: '' };
    }
    return {
      display: 'flex',
      dotClass: 'connection-dot draining',
      text: showBacklog ? `Sending ${formatBytes(totalBytes)}...` : 'Sending...',
      title: 'Delivering queued input',
    };
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    // Called on EVERY keystroke (_reliableSend) and EVERY ACK (_ackDelivery).
    // During fast typing the rendered tuple is usually identical, so skip the DOM
    // writes when nothing changed (COD-136) — the compute above is DOM-free.
    const next = this._computeConnectionDescriptor();
    const prev = this._lastIndicatorDescriptor;
    if (
      prev &&
      prev.display === next.display &&
      prev.dotClass === next.dotClass &&
      prev.text === next.text &&
      prev.title === next.title
    ) {
      return;
    }
    this._lastIndicatorDescriptor = next;

    indicator.style.display = next.display;
    if (next.display !== 'none') {
      dot.className = next.dotClass;
      text.textContent = next.text;
      indicator.title = next.title;
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      this.connectSSE();
      // Network came back — drain durably-queued input right away.
      this._redeliverSweep();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });
  }

  /** Show/hide the CJK input textarea based on user setting or server override */
  _updateCjkInputState() {
    const cjkEl = document.getElementById('cjkInput');
    if (!cjkEl) return;
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings?.() || {};
    // Mobile defaults ship cjkInputEnabled: false (native terminal input by
    // default on touch), but an explicit user enable is honored everywhere —
    // the App Settings toggle must not be a silent no-op on phones.
    // The welcome/home screen (no active session) has nothing to type into.
    // Force-hide the CJK textarea there — otherwise the `position: fixed`
    // `.cjk-input-visible` rule floats it over the welcome overlay and blocks
    // content. Re-synced on session enter/leave via hideWelcome()/showWelcome().
    const cjkUserEnabled =
      this._serverCjkOverride || (settings.cjkInputEnabled ?? defaults.cjkInputEnabled ?? false);
    const showCjk = cjkUserEnabled && !!this.activeSessionId;
    cjkEl.classList.toggle('cjk-input-visible', !!showCjk);
    document.body.classList.toggle('cjk-input-visible', !!showCjk);
    cjkEl.style.display = showCjk ? 'block' : 'none';
    cjkEl.setAttribute('aria-hidden', showCjk ? 'false' : 'true');
    if (!showCjk) window.cjkActive = false;
    if (typeof KeyboardHandler !== 'undefined') KeyboardHandler.updateLayoutForKeyboard();
  }

  /**
   * COD-103: reflect which Codeman CLI alias is on PATH in user-facing help text.
   * Sets the Agent Checkpoint hint's `<code>` to the resolved alias and toggles a
   * sibling not-on-PATH warning. The attachment-drawer empty state reads
   * `this.codemanCli` on its own re-render (see panels-ui renderAttachmentHistory),
   * so re-render it here if it's currently open.
   */
  _applyCodemanCliHints() {
    const cli = this.codemanCli || { onPath: true, name: 'aicodeman' };
    const name = cli.name || 'aicodeman';
    const codeEl = document.getElementById('checkpointCliHint');
    if (codeEl) codeEl.textContent = `${name} checkpoint -m compact|clear`;
    const warnEl = document.getElementById('checkpointCliPathWarning');
    if (warnEl) warnEl.hidden = cli.onPath !== false ? true : false;
    // Refresh the attachment drawer empty state only if the drawer already
    // exists and is showing the empty state (don't eagerly create the drawer).
    if (document.getElementById('attachmentHistoryDrawer') && !(this.attachmentHistoryItems || []).length) {
      this.renderAttachmentHistory?.();
    }
  }

  _isUsableXtermSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'string' || snapshot.length < 8) return false;
    const visibleText = snapshot
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-2A-Z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();
    return visibleText.length >= 3;
  }

  /**
   * Reset all app state maps, timers, and handlers to a clean baseline.
   * Called by handleInit() on SSE reconnect / page reload to prevent
   * memory leaks and stale data.
   */
  _resetAllAppState() {
    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    this.terminalBufferCache.clear();
    this._xtermSnapshots?.clear();
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear flicker filter state
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    this._clearTimer('syncWaitTimeout');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    // Abort any in-flight chunkedTerminalWrite (SSE reconnect reloads buffers)
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // Preserve local echo overlay text across SSE reconnect — just hide until
    // terminal buffer reloads and prompt is visible again.  _render() re-scans
    // for the ❯ prompt on every call, so rerender() after buffer load repositions it.
    this._localEchoOverlay?.rerender();
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear parent name cache (prevents stale session name entries accumulating)
    if (this._parentNameCache) this._parentNameCache.clear();
    // Clear subagent activity/results maps (prevents leaks if data.subagents is missing)
    this.subagentActivity.clear();
    this.subagentToolResults.clear();
    // Clear ultracode workflow run state (re-seeded from data.workflowRuns below)
    if (this.workflowRuns) this.workflowRuns.clear();
    if (this.workflowRunDetails) this.workflowRunDetails.clear();
    this.activeWorkflowRunId = null;
    this.activeWorkflowPhaseIndex = null;
    // Clean up mobile/keyboard handlers and re-init (prevents listener accumulation on reconnect)
    MobileDetection.cleanup();
    KeyboardHandler.cleanup();
    MobileDetection.init();
    KeyboardHandler.init();
    // Clear tab alerts
    this.tabAlerts.clear();
    this.attachmentHistoryCounts.clear();
    // Clear shown completions (used for duplicate notification prevention)
    if (this._shownCompletions) {
      this._shownCompletions.clear();
    }
    // Clear notification manager title flash interval to prevent memory leak
    if (this.notificationManager?.titleFlashInterval) {
      clearInterval(this.notificationManager.titleFlashInterval);
      this.notificationManager.titleFlashInterval = null;
    }
    // Clear notification manager grouping timeouts (prevents orphaned timers)
    if (this.notificationManager?.groupingMap) {
      for (const { timeout } of this.notificationManager.groupingMap.values()) {
        clearTimeout(timeout);
      }
      this.notificationManager.groupingMap.clear();
    }
    // Disconnect terminal resize observer (prevents memory leak on reconnect)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
      this.terminalResizeObserver = null;
    }
    // Clear any other orphaned timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
  }

  handleInit(data) {
    // Clear the init fallback timer since we got data
    this._clearTimer('_initFallbackTimer');
    const gen = ++this._initGeneration;

    // CJK input form: controlled by user setting (with server env as override)
    this._serverCjkOverride = data.inputCjkForm || false;
    this._updateCjkInputState();

    // COD-103: which Codeman CLI alias is on PATH, for the checkpoint hint and
    // the attachment-drawer empty state. Persist so panels-ui can read it on
    // re-render; update the static checkpoint hint now.
    this.codemanCli = data.codemanCli || { onPath: true, name: 'aicodeman' };
    this._applyCodemanCliHints();
    // Plan-usage chip: server's last-known telemetry, so it shows immediately on
    // a fresh load / reconnect (authoritative; wins over the localStorage restore).
    if (data.planUsage) this.updatePlanUsageChip(data.planUsage);

    // Update version displays (header and toolbar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Codeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Codeman v${data.version}`;
      }
    }

    // Stop any active voice recording on reconnect
    VoiceInput.cleanup();

    this._resetAllAppState();

    data.sessions.forEach(s => {
      this.sessions.set(s.id, s);
      this.updateAttachmentHistoryCountFromSession?.(s);
      // Load ralph state from session data (only if not explicitly closed by user)
      if ((s.ralphLoop || s.ralphTodos) && !this.ralphClosedSessions.has(s.id)) {
        this.ralphStates.set(s.id, {
          loop: s.ralphLoop || null,
          todos: s.ralphTodos || []
        });
      }
    });

    // Server is source of truth for open sessions — don't resurrect stale tabs
    // from localStorage (would show phantom "ended" tabs when a session was closed
    // on another device).
    try { localStorage.removeItem('codeman-tab-meta'); } catch {}

    // COD-131: server is authoritative for global tab order. Seed localStorage
    // from the server snapshot (if present) so syncSessionOrder() reconciles
    // against the cross-device order rather than this device's stale local copy.
    if (Array.isArray(data.sessionOrder) && data.sessionOrder.length) {
      try { localStorage.setItem('codeman-session-order', JSON.stringify(data.sessionOrder)); } catch {}
    }

    // Sync sessionOrder with current sessions (preserve order, add new, remove stale)
    this.syncSessionOrder();

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
    } else {
      // Clear respawn status on init if not provided (prevents stale data)
      this.respawnStatus = {};
    }
    // Clean up respawn state for sessions that no longer exist
    this.respawnTimers = {};
    this.respawnCountdownTimers = {};
    this.respawnActionLogs = {};

    // Store global stats for aggregate tracking
    if (data.globalStats) {
      this.globalStats = data.globalStats;
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    this.updateCost();
    this.renderSessionTabs();

    // Start/stop system stats polling based on session count
    if (this.sessions.size > 0) {
      this.startSystemStatsPolling();
    } else {
      this.stopSystemStatsPolling();
    }

    // CRITICAL: Clean up all floating windows before loading new subagents
    // This prevents memory leaks from ResizeObservers, EventSources, and DOM elements
    this.cleanupAllFloatingWindows();

    // Load subagents - clear all related maps to prevent memory leaks on reconnect
    if (data.subagents) {
      this.subagents.clear();
      this.subagentActivity.clear();
      this.subagentToolResults.clear();
      data.subagents.forEach(s => {
        this.subagents.set(s.agentId, s);
      });
      this.renderSubagentPanel();

      // Load PERSISTENT parent associations FIRST, before restoring windows
      // This ensures connection lines are drawn to the correct tabs
      // Clear the in-memory map first to ensure fresh state from storage
      this.subagentParentMap.clear();
      this.loadSubagentParentMap().then(() => {
        // Apply stored parent associations to agents
        for (const [agentId, sessionId] of this.subagentParentMap) {
          const agent = this.subagents.get(agentId);
          if (agent && this.sessions.has(sessionId)) {
            agent.parentSessionId = sessionId;
            const session = this.sessions.get(sessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
          }
        }

        // Now try to find parents for any agents that don't have one yet
        for (const [agentId] of this.subagents) {
          if (!this.subagentParentMap.has(agentId)) {
            this.findParentSessionForSubagent(agentId);
          }
        }

        // Finally, restore window states (this opens windows with correct parent info)
        this.restoreSubagentWindowStates();
      });
    }

    // Seed ultracode workflow runs (LEFT-pane summaries) from the snapshot
    if (data.workflowRuns) {
      this.seedWorkflowRuns(data.workflowRuns);
    }

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;

    // Solo (detached) window: always show exactly the target session, ignoring
    // the dashboard's "restore last active" logic.
    if (this.isSoloWindow) {
      this._applySoloMode();
      return;
    }

    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    this.updateFileBrowserHeaderButton?.();
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
      }
      if (restoreId && this.sessions.has(restoreId)) {
        this.selectSession(restoreId);
      } else {
        this.selectSession(this.sessionOrder[0]);
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data?.data ?? {});
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Debounce Utility
  // ═══════════════════════════════════════════════════════════════

  /** Debounce a method call using a named timer key. */
  _debouncedCall(timerKey, fn, delayMs = 100) {
    if (this._debounceTimers[timerKey]) {
      clearTimeout(this._debounceTimers[timerKey]);
    }
    this._debounceTimers[timerKey] = setTimeout(() => {
      this._debounceTimers[timerKey] = null;
      fn.call(this);
    }, delayMs);
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Tabs
  // ═══════════════════════════════════════════════════════════════

  renderSessionTabs() {
    this.updateFileBrowserHeaderButton?.();
    // Don't re-render while user is typing in the inline rename input
    if (this._inlineRenameActive) return;
    this._debouncedCall('sessionTabs', this._renderSessionTabsImmediate);
  }

  /** Toggle .active class on tabs immediately (no debounce). Used by selectSession(). */
  _updateActiveTabImmediate(sessionId) {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tabs = container.querySelectorAll('.session-tab[data-id]');
    for (const tab of tabs) {
      if (tab.dataset.id === sessionId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
  }

  _setTerminalLoadState(sessionId, selectGen, phase) {
    this.terminalLoadStates.set(sessionId, { generation: selectGen, phase });
    this._updateTerminalLoadTab(sessionId);
  }

  _clearTerminalLoadState(sessionId, selectGen) {
    const state = this.terminalLoadStates.get(sessionId);
    if (state && state.generation !== selectGen) return;
    this.terminalLoadStates.delete(sessionId);
    this._updateTerminalLoadTab(sessionId);
  }

  _updateTerminalLoadTab(sessionId) {
    const tab = this.$('sessionTabs')?.querySelector(`.session-tab[data-id="${sessionId}"]`);
    if (!tab) return;

    const loadState = this.terminalLoadStates.get(sessionId);
    tab.classList.toggle('tab-loading', !!loadState);
    if (loadState) {
      tab.setAttribute('aria-busy', 'true');
      tab.dataset.loadPhase = loadState.phase;
      if (!tab.querySelector('.tab-load-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'tab-load-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const numberEl = tab.querySelector('.tab-number');
        if (numberEl) {
          numberEl.insertAdjacentElement('afterend', spinner);
        } else {
          tab.insertBefore(spinner, tab.firstChild);
        }
      }
    } else {
      tab.setAttribute('aria-busy', 'false');
      delete tab.dataset.loadPhase;
      tab.querySelector('.tab-load-spinner')?.remove();
    }
  }

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Web tabs live in the same strip but are not in this.sessions, so they need
    // their own change check. Without it, the session-only comparison below is
    // vacuously "unchanged" whenever session count is stable — most visibly with
    // ZERO sessions (0 === 0), where opening a dashboard would never draw its tab.
    const existingWebIds = [...container.querySelectorAll('.session-tab[data-webview-id]')].map(
      t => t.dataset.webviewId
    );
    const wantedWebIds = (this.webviewOrder || []).filter(id => this.webviews?.has(id));
    const webTabsUnchanged =
      existingWebIds.length === wantedWebIds.length && existingWebIds.every((id, i) => id === wantedWebIds[i]);

    // Check if we can do incremental update (same session IDs and same web tabs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id)) &&
      webTabsUnchanged;

    if (canIncremental) {
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        // A web tab owns the active state while one is open. activeSessionId stays
        // set (the terminal keeps streaming underneath, and switching back is
        // instant): only the highlight moves. Without this the debounced render
        // re-marks the session tab active moments after a web tab was selected,
        // leaving two tabs lit at once.
        const isActive = id === this.activeSessionId && !this.activeWebviewId;
        const status = session.status || 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;
        const loadState = this.terminalLoadStates.get(id);

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
        }

        tab.classList.toggle('tab-loading', !!loadState);
        if (loadState) {
          tab.setAttribute('aria-busy', 'true');
          tab.dataset.loadPhase = loadState.phase;
          if (!tab.querySelector('.tab-load-spinner')) {
            const spinner = document.createElement('span');
            spinner.className = 'tab-load-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const numberEl = tab.querySelector('.tab-number');
            if (numberEl) {
              numberEl.insertAdjacentElement('afterend', spinner);
            } else {
              tab.insertBefore(spinner, tab.firstChild);
            }
          }
        } else {
          tab.setAttribute('aria-busy', 'false');
          delete tab.dataset.loadPhase;
          tab.querySelector('.tab-load-spinner')?.remove();
        }

        // Update alert class
        const alertType = this.tabAlerts.get(id);
        const wantAction = alertType === 'action';
        const wantIdle = alertType === 'idle';
        const hasAction = tab.classList.contains('tab-alert-action');
        const hasIdle = tab.classList.contains('tab-alert-idle');
        if (wantAction && !hasAction) { tab.classList.add('tab-alert-action'); tab.classList.remove('tab-alert-idle'); }
        else if (wantIdle && !hasIdle) { tab.classList.add('tab-alert-idle'); tab.classList.remove('tab-alert-action'); }
        else if (!alertType && (hasAction || hasIdle)) { tab.classList.remove('tab-alert-action', 'tab-alert-idle'); }

        // Inject tab-number badge if missing (added after initial render)
        if (!tab.querySelector('.tab-number')) {
          const idx = this.sessionOrder.indexOf(id);
          if (idx >= 0 && idx < 9) {
            const numSpan = document.createElement('span');
            numSpan.className = 'tab-number';
            numSpan.textContent = String(idx + 1);
            tab.insertBefore(numSpan, tab.firstChild);
          }
        }

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Update name if changed
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== name) {
          const _p = parseSessionPrefix(name);
          if (_p && _p.suffix) {
            nameEl.innerHTML = '<span class="tab-prefix">' + escapeHtml(_p.prefix) + '</span><span class="tab-suffix">: ' + escapeHtml(_p.suffix) + '</span>';
          } else {
            nameEl.textContent = name;
          }
        }

        // Update task badge
        const badgeEl = tab.querySelector('.tab-badge');
        if (hasRunningTasks) {
          if (badgeEl) {
            if (badgeEl.textContent !== String(taskStats.running)) {
              badgeEl.textContent = taskStats.running;
            }
          } else {
            // Need to add badge - do full rebuild
            this._fullRenderSessionTabs();
            return;
          }
        } else if (badgeEl) {
          // Need to remove badge - do full rebuild
          this._fullRenderSessionTabs();
          return;
        }

        // Update subagent badge - targeted update without full rebuild
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        if (minimizedCount > 0 && subagentBadgeEl) {
          // Badge exists and still has agents - update label and dropdown in-place
          const labelEl = subagentBadgeEl.querySelector('.subagent-label');
          const newLabel = minimizedCount === 1 ? 'AGENT' : `AGENTS (${minimizedCount})`;
          if (labelEl && labelEl.textContent !== newLabel) {
            labelEl.textContent = newLabel;
          }
          // Rebuild dropdown items (agent list may have changed)
          const dropdownEl = subagentBadgeEl.querySelector('.subagent-dropdown');
          if (dropdownEl) {
            const newBadgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
            const temp = document.createElement('div');
            temp.innerHTML = newBadgeHtml;
            const newDropdown = temp.querySelector('.subagent-dropdown');
            if (newDropdown) {
              dropdownEl.innerHTML = newDropdown.innerHTML;
            }
          }
        } else if (minimizedCount > 0 && !subagentBadgeEl) {
          // Need to add badge - insert before gear icon
          const badgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
          const gearEl = tab.querySelector('.tab-gear');
          if (gearEl) {
            gearEl.insertAdjacentHTML('beforebegin', badgeHtml);
          }
        } else if (minimizedCount === 0 && subagentBadgeEl) {
          // Count went to 0 - remove badge
          subagentBadgeEl.remove();
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

    this.updateTabOverflowMode();
  }

  // Auto-wrap desktop session tabs to a second row when they overflow one row,
  // unless the user has pinned the manual two-row layout (tabTwoRows). Mobile/
  // tablet keep horizontal scroll. Policy lives in constants.js for unit testing.
  updateTabOverflowMode() {
    const container = this.$('sessionTabs');
    if (!container) return;

    const deviceType = MobileDetection.getDeviceType();
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const manualTwoRows = deviceType === 'desktop' ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false) : false;

    if (manualTwoRows || deviceType !== 'desktop') {
      container.classList.remove('tabs-auto-wrap');
      // Manual two-rows on desktop wraps the header too; non-desktop never wraps.
      this._applyHeaderRightWrap(deviceType, manualTwoRows, false);
      return;
    }

    // Measure the natural one-row overflow against a STATE-INDEPENDENT reference
    // frame, then enable wrapping only if needed.
    //
    // COD-147 couples the tab-wrap decision to the header: when tabs wrap we also add
    // `.header--tabs-wrapped`, which shrinks `.header-right` and WIDENS the tab area.
    // That widened clientWidth is the very number we measure below — so if we measured
    // while the header were still wrapped, a tab set that overflows the NARROW area but
    // fits the WIDE one would report "fits" -> unwrap -> narrow area overflows -> wrap
    // -> ... flip-flopping 1<->2 rows on every SSE-driven tab re-render (the s1-rental
    // flicker). Reset the header to its unwrapped baseline BEFORE measuring so the
    // decision depends only on natural tab width vs the fixed narrow area — a stable
    // fixed point. (No paint happens between these class writes and the measure: the
    // browser only repaints after this synchronous frame completes.)
    const wasWrapped = container.classList.contains('tabs-auto-wrap');
    container.classList.remove('tabs-auto-wrap');
    document.querySelector('.header')?.classList.remove('header--tabs-wrapped');
    const shouldWrap = window.CodemanTabOverflow?.shouldAutoWrapTabs
      ? window.CodemanTabOverflow.shouldAutoWrapTabs({
          deviceType,
          manualTwoRows,
          tabCount: this.sessions.size,
          scrollWidth: container.scrollWidth,
          clientWidth: container.clientWidth,
        })
      : container.scrollWidth > container.clientWidth + 1;

    container.classList.toggle('tabs-auto-wrap', shouldWrap);
    // COD-147: mirror the final tab-wrap state onto the header so .header-right wraps too.
    this._applyHeaderRightWrap(deviceType, manualTwoRows, shouldWrap);
    // COD-213: when wrap state changes the header height changes, shrinking/growing the
    // terminal container. The ResizeObserver fires but with a 300ms debounce — call
    // fit() immediately so dimensions are correct the instant the layout settles.
    if (shouldWrap !== wasWrapped) this.fitAddon?.fit();
  }

  // COD-147: toggle `header--tabs-wrapped` so the right-side cluster wraps to a
  // 2nd line when tabs do, freeing horizontal width for the tab area.
  _applyHeaderRightWrap(deviceType, manualTwoRows, autoWrap) {
    const header = document.querySelector('.header');
    if (!header) return;
    const wrapped = window.CodemanTabOverflow?.shouldWrapHeaderRight
      ? window.CodemanTabOverflow.shouldWrapHeaderRight({ deviceType, manualTwoRows, autoWrap })
      : deviceType === 'desktop' && (manualTwoRows || autoWrap);
    header.classList.toggle('header--tabs-wrapped', wrapped);
  }

  toggleMobileHeaderUtilities() {
    const header = document.querySelector('.header');
    const appShell = document.querySelector('.app');
    const toggle = document.querySelector('.mobile-header-utility-toggle');
    if (!header || !appShell || !toggle) return;

    const expanded = header.classList.toggle('mobile-utilities-expanded');
    appShell.classList.toggle('mobile-header-utilities-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    window.dispatchEvent(new Event('resize'));
  }

  _fullRenderSessionTabs() {
    if (this._inlineRenameActive) return;
    const container = this.$('sessionTabs');

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // Build tabs HTML using array for better string concatenation performance
    // Iterate in sessionOrder to respect user's custom tab arrangement
    // On mobile: put active session first (only one tab visible anyway)
    const parts = [];
    let tabOrder = this.sessionOrder;
    if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
      // Reorder to put active tab first
      tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
    }
    let _tabIdx = 0;
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      // See the note in the incremental path: a web tab owns the active highlight
      // while one is open, even though activeSessionId stays set.
      const isActive = id === this.activeSessionId && !this.activeWebviewId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';
      const loadState = this.terminalLoadStates.get(id);

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';

      // Ultracode runs + agent transcripts minimized to this tab (ultracode-windows.js
      // renders one merged ULTRA badge; returns '' when nothing is minimized).
      const ultracodeBadge = this.renderUltracodeTabBadge ? this.renderUltracodeTabBadge(id) : '';

      // Show folder name if session has a custom name AND tall tabs setting is enabled
      const folderName = session.workingDir ? session.workingDir.split('/').pop() || '' : '';
      const tallTabsEnabled = this._tallTabsEnabled ?? false;
      const showFolder = tallTabsEnabled && session.name && folderName && folderName !== name;

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}${this.detachedSessions.has(id) ? ' detached' : ''}${loadState ? ' tab-loading' : ''}" data-id="${id}" data-color="${color}" ${loadState ? `data-load-phase="${escapeHtml(loadState.phase)}"` : ''} onclick="app.handleSessionTabClick(event, ${escapeHtml(JSON.stringify(id))})" oncontextmenu="event.preventDefault(); app.startInlineRename(${escapeHtml(JSON.stringify(id))})" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-busy="${loadState ? 'true' : 'false'}" aria-label="${escapeHtml(name)} session" ${session.workingDir ? `title="${escapeHtml(session.workingDir)}"` : ''}>
          ${_tabIdx < 9 ? '<span class="tab-number">' + (_tabIdx + 1) + '</span>' : ''}
          ${loadState ? '<span class="tab-load-spinner" aria-hidden="true"></span>' : ''}
          <span class="tab-status ${status}" aria-hidden="true"></span>
          <span class="tab-info">
            <span class="tab-name-row">
              ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : mode === 'codex' ? '<span class="tab-mode codex" aria-hidden="true">cx</span>' : mode === 'gemini' ? '<span class="tab-mode gemini" aria-hidden="true">gm</span>' : mode === 'agy' ? '<span class="tab-mode agy" aria-hidden="true">ag</span>' : ''}
              <span class="tab-name" data-session-id="${id}">${(() => { const p = parseSessionPrefix(name); return p && p.suffix ? '<span class="tab-prefix">' + escapeHtml(p.prefix) + '</span><span class="tab-suffix">: ' + escapeHtml(p.suffix) + '</span>' : escapeHtml(name); })()}</span>
              <span class="tab-detached-badge" aria-hidden="true">detached</span>
            </span>
            ${showFolder ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(folderName)}</span>` : ''}
          </span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          ${ultracodeBadge}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions(${escapeHtml(JSON.stringify(id))})" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span>
          <span class="tab-detach" onclick="event.stopPropagation(); app.detachSession(${escapeHtml(JSON.stringify(id))})" title="Open in a new window" aria-label="Open session in a new window" tabindex="0">&#x29C9;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession(${escapeHtml(JSON.stringify(id))})" title="Close session" aria-label="Close session" tabindex="0">&times;</span>
        </div>`);
      _tabIdx++;
    }

    // Web tabs (dashboard URLs) render after the session tabs, continuing the
    // Alt+N numbering. They carry data-webview-id instead of data-id, so every
    // session-tab code path above (drag-and-drop, alerts, badges) skips them.
    parts.push(this.renderWebviewTabs ? this.renderWebviewTabs(_tabIdx) : '');

    container.innerHTML = parts.join('');

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    this.updateTabOverflowMode();

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();

    // Re-evaluate desktop auto-wrap for every full rebuild, including the incremental
    // branch's early `_fullRenderSessionTabs(); return;` paths and the manual two-rows
    // toggle (applyTabWrapSettings calls this) which would otherwise leave a stale
    // tabs-auto-wrap class until the next content render.
    this.updateTabOverflowMode();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      const tabs = [...container.querySelectorAll('.session-tab')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId);
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
          newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      tabs[newIndex]?.focus();
    };

    container.addEventListener('keydown', this._tabKeydownHandler);
  }

  handleSessionTabClick(event, sessionId) {
    event?.preventDefault?.();
    // On touch with the keyboard hidden, blur the tapped tab so switching
    // sessions doesn't pop the on-screen keyboard. Focus policy itself lives
    // in selectSession via _shouldFocusTerminalForTabSwitch().
    const keyboardOpen = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible === true;
    if (!keyboardOpen && MobileDetection.isTouchDevice()) {
      document.activeElement?.blur?.();
    }
    return this.selectSession(sessionId);
  }


  // ═══════════════════════════════════════════════════════════════
  // Tab Order and Drag-and-Drop
  // ═══════════════════════════════════════════════════════════════

  // Sync sessionOrder with current sessions (preserve order for existing, add new at end)
  syncSessionOrder() {
    const currentIds = new Set(this.sessions.keys());

    // Load saved order from localStorage
    const savedOrder = this.loadSessionOrder();

    // Start with saved order, keeping only sessions that still exist
    const preserved = savedOrder.filter(id => currentIds.has(id));
    const preservedSet = new Set(preserved);

    // Add any new sessions at the end
    const newSessions = [...currentIds].filter(id => !preservedSet.has(id));

    this.sessionOrder = [...preserved, ...newSessions];
  }

  // Load session order from localStorage
  loadSessionOrder() {
    try {
      const saved = localStorage.getItem('codeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage and (debounced) sync to the server so it
  // follows the user across devices (COD-131). localStorage stays the offline
  // fallback; the server is authoritative and echoes back via SSE.
  saveSessionOrder() {
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
    }
    const order = [...this.sessionOrder];
    this._debouncedCall('saveSessionOrderServer', () => {
      fetch('/api/session-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      }).catch(() => {});
    }, 400);
  }

  // COD-131: another device (or our own debounced push) reordered tabs. Adopt the
  // server order as the new base and reconcile to our currently-open sessions.
  // Guard against no-op churn so an echo of our own push doesn't flicker the tabs.
  _onSessionOrderChanged(data) {
    if (!data || !Array.isArray(data.order)) return;
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(data.order));
    } catch {
      // Ignore storage errors
    }
    const before = JSON.stringify(this.sessionOrder);
    this.syncSessionOrder();
    // Only re-render when the reconciled order actually changed (avoids flicker
    // when the broadcast is just an echo of the order we already have).
    if (JSON.stringify(this.sessionOrder) !== before) {
      this._fullRenderSessionTabs();
    }
  }

  // Set up drag-and-drop handlers on tab elements
  setupTabDragHandlers() {
    const container = this.$('sessionTabs');
    const tabs = container.querySelectorAll('.session-tab[data-id]');

    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        this.draggedTabId = tab.dataset.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.dataset.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        this.draggedTabId = null;
        // Remove all drag-over indicators
        container.querySelectorAll('.session-tab').forEach(t => {
          t.classList.remove('drag-over-left', 'drag-over-right');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position based on mouse position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const isLeftHalf = e.clientX < midpoint;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', isLeftHalf);
        tab.classList.toggle('drag-over-right', !isLeftHalf);
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over-left', 'drag-over-right');

        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        const targetId = tab.dataset.id;
        const draggedId = this.draggedTabId;

        // Determine insertion position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midpoint;

        // Reorder sessionOrder array
        const fromIndex = this.sessionOrder.indexOf(draggedId);
        let toIndex = this.sessionOrder.indexOf(targetId);

        if (fromIndex === -1 || toIndex === -1) return;

        // Remove dragged item
        this.sessionOrder.splice(fromIndex, 1);

        // Recalculate target index after removal
        toIndex = this.sessionOrder.indexOf(targetId);
        if (toIndex === -1) return;

        // Insert at correct position
        if (insertBefore) {
          this.sessionOrder.splice(toIndex, 0, draggedId);
        } else {
          this.sessionOrder.splice(toIndex + 1, 0, draggedId);
        }

        // Save and re-render
        this.saveSessionOrder();
        this._fullRenderSessionTabs();
      });
    });
  }

  moveActiveTabLeft() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx <= 0) return;
    [this.sessionOrder[idx - 1], this.sessionOrder[idx]] = [this.sessionOrder[idx], this.sessionOrder[idx - 1]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  moveActiveTabRight() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx === -1 || idx >= this.sessionOrder.length - 1) return;
    [this.sessionOrder[idx], this.sessionOrder[idx + 1]] = [this.sessionOrder[idx + 1], this.sessionOrder[idx]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle — select, close, navigate
  // ═══════════════════════════════════════════════════════════════

  getShortId(id) {
    if (!id) return '';
    let short = this._shortIdCache.get(id);
    if (!short) {
      short = id.slice(0, 8);
      this._shortIdCache.set(id, short);
    }
    return short;
  }

  getSessionName(session) {
    // Use custom name if set
    if (session.name) {
      return session.name;
    }
    // Fall back to directory name
    if (session.workingDir) {
      return session.workingDir.split('/').pop() || session.workingDir;
    }
    return this.getShortId(session.id);
  }

  _notifySession(sessionId, urgency, category, title, message) {
    const session = this.sessions.get(sessionId);
    this.notificationManager?.notify({
      urgency,
      category,
      sessionId,
      sessionName: session?.name || this.getShortId(sessionId),
      title,
      message,
    });
  }

  /**
   * Clean up state from the previous session before switching tabs.
   * Handles: WebSocket teardown, CJK clear, flicker filter, tab completion,
   * terminal write queue, IME composition, and local echo flush.
   * @param {string} newSessionId - The session being switched TO.
   */
  _isUsableXtermSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'string' || snapshot.length < 8) return false;
    const visibleText = snapshot
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-2A-Z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();
    return visibleText.length >= 3;
  }

  /**
   * Persist one xterm snapshot to localStorage, bounded to a fixed key budget
   * regardless of how many sessions are live, and resilient to quota errors.
   * The previous inline version only pruned snapshots for sessions that no
   * longer existed AND pruned only after a successful setItem — so once the
   * quota filled (e.g. >10 live sessions at the 20-session target) the write
   * threw before the prune could run, permanently disabling persistence.
   */
  _persistXtermSnapshot(key, snapshot) {
    const PREFIX = 'codeman-xs-';
    const MAX_KEYS = 10;
    const others = () => Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) && k !== key);
    try {
      // Evict down to the budget before writing a NEW key, dead sessions first
      // then oldest. (Overwriting an existing key doesn't grow the key count.)
      if (localStorage.getItem(key) === null) {
        const live = new Set(Array.from(this.sessions?.keys?.() || []));
        const pool = others().sort(
          (a, b) =>
            Number(live.has(a.slice(PREFIX.length))) - Number(live.has(b.slice(PREFIX.length)))
        );
        while (pool.length >= MAX_KEYS) localStorage.removeItem(pool.shift());
      }
      try {
        localStorage.setItem(key, snapshot);
      } catch (_quota) {
        // Quota exceeded: drop other snapshots one at a time and retry so a full
        // quota can't permanently disable persistence.
        for (const victim of others()) {
          localStorage.removeItem(victim);
          try {
            localStorage.setItem(key, snapshot);
            return;
          } catch (_again) {
            /* keep evicting */
          }
        }
        try { localStorage.removeItem(key); } catch {}
      }
    } catch (_unavailable) {
      /* localStorage unavailable (Safari private mode / disabled) — in-memory only */
    }
  }

  _cleanupPreviousSession(newSessionId) {
    // Snapshot the OUTGOING session's xterm rendered state (viewport + scrollback +
    // colors/attrs) before the terminal gets cleared/reset. Lets us restore the
    // exact view on switch-back rather than replaying codex's byte stream, which
    // drops earlier conversation from each TUI redraw and ends up showing only
    // the latest (idle) frame.
    // Shell sessions are never restored from a snapshot (restore is gated on
    // mode !== 'shell'), so skip the serialize() + cache slot + localStorage
    // quota for them. Unknown/undefined mode still snapshots, matching restore.
    const outgoingSession = this.activeSessionId ? this.sessions?.get?.(this.activeSessionId) : null;
    // COD-187: leaving a history view (or any mirror tab) — reset live-mirror
    // state; a scrollback-0 serialize is worthless, so skip the snapshot too.
    const outgoingMirror = this.activeSessionId && this._isMirrorSession(this.activeSessionId);
    if (outgoingMirror || this._viewMode === 'history') {
      this._viewMode = 'live';
      this._historyLoadGen++;
      this._historyMissedOutput = false;
      this._historyPrefetch = null;
      this._hideHistoryPill?.();
    }
    if (
      this.activeSessionId &&
      !outgoingMirror &&
      outgoingSession?.mode !== 'shell' &&
      this._serializeAddon &&
      this._xtermSnapshots
    ) {
      try {
        const snapshot = this._serializeAddon.serialize({ scrollback: 1000 });
        if (this._isUsableXtermSnapshot(snapshot)) {
          // Delete-before-set so re-touching a session moves it to the end of
          // the Map's insertion order — otherwise eviction is FIFO and can drop
          // the most-recently-used session instead of the least.
          this._xtermSnapshots.delete(this.activeSessionId);
          this._xtermSnapshots.set(this.activeSessionId, snapshot);
          // Cap in-memory snapshot cache at 20 entries; evict oldest on overflow.
          if (this._xtermSnapshots.size > 20) {
            const oldest = this._xtermSnapshots.keys().next().value;
            this._xtermSnapshots.delete(oldest);
          }
          // Persist to localStorage so the snapshot survives tab discard /
          // browser reload (Chrome discards inactive tabs after idle periods,
          // wiping in-memory state). Cap per-snapshot at 256KB; codex
          // buffer-replay produces a visual mess of stacked banner redraws when
          // no snapshot exists, so persistence matters more here than for claude.
          if (snapshot.length < 256 * 1024) {
            this._persistXtermSnapshot(`codeman-xs-${this.activeSessionId}`, snapshot);
          }
        } else {
          this._xtermSnapshots.delete(this.activeSessionId);
          try { localStorage.removeItem(`codeman-xs-${this.activeSessionId}`); } catch {}
        }
      } catch (_err) {
        /* Serialize failed — fall back to server buffer replay */
      }
    }

    // Close WebSocket for previous session (new one opens after buffer load)
    this._disconnectWs();

    // Clear CJK input to prevent sending stale text to the wrong session.
    // Must go through CjkInput.clear() — a raw value wipe leaves the module's
    // pending flush timers armed and drops the phantom char it relies on.
    if (typeof CjkInput !== 'undefined') {
      CjkInput.clear();
    } else {
      const cjkEl = document.getElementById('cjkInput');
      if (cjkEl) cjkEl.value = '';
    }

    // Clean up flicker filter state when switching sessions
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clear tab completion detection flag — don't carry across sessions
    this._tabCompletionSessionId = null;
    this._tabCompletionRetries = 0;
    this._tabCompletionBaseText = null;
    this._clearTimer('_tabCompletionFallback');
    this._clearTimer('_clientDropRecoveryTimer');

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    this._clearTimer('syncWaitTimeout');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    // Abort any in-flight chunkedTerminalWrite from the previous session.
    // Without this, old rAF-scheduled chunks continue writing stale data
    // into the terminal, interleaving with the new session's buffer.
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // End any in-flight IME composition.
    // iOS Safari keeps autocorrect composing; switching tabs without ending it
    // leaves xterm's _compositionHelper._isComposing stuck true, which blocks
    // keyboard input when the user returns to this tab.
    try {
      const ch = this.terminal?._core?._compositionHelper;
      if (ch?._isComposing) {
        ch._isComposing = false;
        // Also fire compositionend on the textarea so any other listeners reset
        const ta = this.terminal?.element?.querySelector('.xterm-helper-textarea');
        if (ta) ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      }
    } catch {}
    // Flush local echo text to PTY before switching tabs.
    // Send as a single batch (no Enter) so it lands in the session's readline
    // input buffer — avoids "old text resent on Enter" and overlay render bugs.
    // Track flushed length so _render() offsets the overlay correctly even before
    // the PTY echo arrives in the terminal buffer.
    if (this.activeSessionId) {
      const echoText = this._localEchoOverlay?.pendingText || '';
      // Include buffer-detected flushed text (from Tab completion, etc.)
      // so it's preserved across tab switches.
      const existingFlushed = this._localEchoOverlay?.getFlushed()?.count || 0;
      const existingFlushedText = this._localEchoOverlay?.getFlushed()?.text || '';
      if (echoText) {
        this._sendInputAsync(this.activeSessionId, echoText);
      }
      const totalOffset = existingFlushed + echoText.length;
      if (totalOffset > 0) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedOffsets.set(this.activeSessionId, totalOffset);
        this._flushedTexts.set(this.activeSessionId, existingFlushedText + echoText);
      }
    }
    this._localEchoOverlay?.clear();
    // Prevent _detectBufferText() from picking up Claude's Ink UI text
    // (status bar, model info, etc.) as "user input" on fresh sessions.
    // Only sessions with prior flushed text (from tab-switch-away) need detection.
    // After the user's first Enter, clear() resets _bufferDetectDone = false,
    // re-enabling detection for tab completion and other legitimate cases.
    if (this._localEchoOverlay && !this._flushedOffsets?.has(newSessionId)) {
      this._localEchoOverlay.suppressBufferDetection();
    }
  }

  _resetTerminalForReplay() {
    this.terminal.reset();
    this.terminal.write('\x1b[3J\x1b[H\x1b[2J');
  }

  _shouldFocusTerminalForTabSwitch() {
    if (typeof MobileDetection === 'undefined' || !MobileDetection.isTouchDevice()) {
      return true;
    }
    return typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
  }

  async selectSession(sessionId, options = {}) {
    // If this session is popped out into its own window, raise that window
    // instead of showing it inline (focus-on-click for detached tabs). If we
    // owned a now-closed window, _raiseDetached re-docks and returns false so
    // we fall through to normal inline selection.
    if (!this.isSoloWindow && this.detachedSessions.has(sessionId)) {
      if (this._raiseDetached(sessionId)) return;
    }
    const forceReload = options?.forceReload === true;
    this.closeMobileHeaderUtilities?.();
    if (this.activeSessionId === sessionId && !forceReload) return;
    if (this.activeSessionId === sessionId && forceReload) {
      this.terminalBufferCache?.delete(sessionId);
      this._clearTimer('syncWaitTimeout');
      this.pendingWrites = [];
      this.writeFrameScheduled = false;
      this._isLoadingBuffer = false;
      this._loadBufferQueue = null;
      this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
      this.activeSessionId = null;
    }
    // Focus terminal SYNCHRONOUSLY before any await — iOS Safari only honors
    // programmatic focus() within the user-gesture call stack (e.g. tab click).
    // After the first await the gesture context is lost and focus() is silently
    // ignored, leaving the keyboard unable to send input to the terminal.
    // Desktop always focuses; touch focuses only while the on-screen keyboard
    // is already open (so a tab switch doesn't pop the keyboard).
    const shouldFocusTerminal = this._shouldFocusTerminalForTabSwitch();
    if (shouldFocusTerminal && this.terminal) this.terminal.focus();

    const _selStart = performance.now();
    const _selName = this.sessions.get(sessionId)?.name || sessionId.slice(0,8);
    _crashDiag.log(`SELECT: ${_selName}`);
    console.log(`[CRASH-DIAG] selectSession START: ${sessionId.slice(0,8)}`);

    const selectGen = ++this._selectGeneration;
    this._setTerminalLoadState(sessionId, selectGen, 'resizing');

    if (selectGen !== this._selectGeneration) {
      this._clearTerminalLoadState(sessionId, selectGen);
      return; // newer tab switch won
    }

    // A session tab takes the stage back from any active web tab.
    this._hideWebviewLayer?.();

    this._cleanupPreviousSession(sessionId);
    // COD-187: scrollback ownership — mirror tabs run at 0 (pure screen
    // mirror; nothing accumulates), everything else gets the user's value
    // back. The ONLY other writers are _enterHistoryView/_exitHistoryView.
    this.terminal.options.scrollback = this._isMirrorSession(sessionId) ? 0 : this._userScrollback();
    this.activeSessionId = sessionId;
    try { localStorage.setItem('codeman-active-session', sessionId); } catch {}
    // Narrow SSE filter to the active session — server stops streaming
    // session:terminal events for other sessions to this client. Cuts
    // SSE traffic ~Nx for N concurrent sessions. Fire-and-forget; on the
    // rare race where server doesn't know our clientId yet, the next
    // selectSession or reconnect catches up.
    this._updateSseSubscription(sessionId);
    // Open WebSocket as soon as the active session is known. It does not
    // depend on terminal buffer loading, and opening it early keeps normal
    // typing on the ordered WS path instead of temporary HTTP fallback.
    this._connectWs(sessionId);
    this.hideWelcome();
    // Clear idle hooks on view, but keep action hooks until user interacts
    this.clearPendingHooks(sessionId, 'idle_prompt');
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    this.renderSessionTabs();
    this.updateAttachmentHistoryBadge?.();
    if (this.attachmentHistoryDrawerOpen) {
      this.loadAttachmentHistory?.(sessionId);
    }
    this._updateLocalEchoState();

    // Restore flushed offset AND text IMMEDIATELY so backspace/typing work during
    // the async buffer load.  Without this, the offset is 0 during the
    // fetch() gap: backspace is swallowed, and typing a space covers the
    // canvas text with an opaque overlay showing only the new char.
    if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
      this._localEchoOverlay.setFlushed(
        this._flushedOffsets.get(sessionId),
        this._flushedTexts?.get(sessionId) || '',
        false  // render=false: buffer not loaded yet
      );
    }

    // Glow the newly-active tab
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }

    // Check if this is a restored session that needs to be attached
    const session = this.sessions.get(sessionId);

    // Track working directory for path normalization in Project Insights
    this.currentSessionWorkingDir = session?.workingDir || null;
    if (session && session.pid === null) {
      if (session.respawnBlocked) {
        // COD-118: the PTY-exit circuit breaker tripped for this session — the
        // automatic re-attach must NOT silently clear it (that would re-arm the
        // crash loop on every tab click / page load). Restart only on explicit
        // user confirmation; the confirmed request carries clearBreaker:true.
        const label = session.name || 'Session';
        if (window.confirm(`${label} was stopped after crashing repeatedly. Restart it?`)) {
          try {
            await fetch(`/api/sessions/${sessionId}/interactive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ clearBreaker: true }),
            });
            session.respawnBlocked = false;
            session.status = 'busy';
          } catch (err) {
            console.error('Failed to restart crash-looped session:', err);
          }
        }
      } else {
        // Session has no PTY attached — either restored after server restart
        // or detached for some other reason. Re-attach regardless of status.
        // Deliberately NO body: this automatic path must never clear a tripped
        // PTY-exit breaker (COD-118).
        try {
          const endpoint = session.mode === 'shell'
            ? `/api/sessions/${sessionId}/shell`
            : `/api/sessions/${sessionId}/interactive`;
          await fetch(endpoint, { method: 'POST' });
          // Update local session state
          session.status = 'busy';
        } catch (err) {
          console.error('Failed to attach to restored session:', err);
        }
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (128KB is enough for recent visible content).
    //
    // Protect flushed state during buffer load: terminal.write() can trigger
    // xterm.js onData responses (DA, OSC, etc.) that would otherwise clear
    // the flushed Maps via the control char handler.  The multi-byte ESC
    // filter catches most cases, but _restoringFlushedState provides a
    // belt-and-suspenders guard for any edge cases.
    this._restoringFlushedState = true;
    // Gate live SSE terminal writes for the ENTIRE buffer load sequence.
    // Without this, SSE events arriving during the fetch() gap compete with
    // the buffer write, causing 70KB+ single-frame flushes that stall WebGL.
    // chunkedTerminalWrite also sets this, but we need it before the fetch too.
    const bufferLoadOwner = this._beginBufferLoad(selectGen);
    // COD-144: track whether the load painted nothing (empty fetch + no cache).
    // For that just-created-session case we flush (not discard) queued SSE events.
    let bufferWasEmpty = false;
    try {
      // Fit terminal to container BEFORE writing any buffer data.
      // If the browser was resized while viewing another session, the terminal
      // canvas may be at stale dimensions — content would render at wrong width.
      if (this.fitAddon) this.fitAddon.fit();

      // Also push the new dimensions to the PTY. Without this, codex/codeman
      // sees the size that was set the last time the throttled resize handler
      // fired (often the size of a different session's container, or the
      // initial tmux default). The visible symptom is codex rendering inside
      // a small region with empty rows below the status bar.
      // sendResize is a no-op on the server when dims haven't changed, so
      // calling it every tab switch is cheap.
      const dimsChanged = await this.sendResize(sessionId, { forceHttp: true }).catch(() => false);
      if (this._isStaleSelect(selectGen)) {
        this._clearTerminalLoadState(sessionId, selectGen);
        return;
      }

      // xterm snapshot restore: if we have a serialized xterm state from a
      // previous visit to this session, restore the user's exact prior view
      // (viewport + scrollback + colors) for an instant first paint. For codex
      // this is also a correctness fix — its byte-stream replay shows only the
      // latest TUI frame (the idle welcome banner) because codex doesn't include
      // earlier conversation in its current redraw. For claude/opencode/gemini
      // the replay is already complete, so the snapshot is purely a faster,
      // scroll-preserving first paint before the canonical fetch reconciles.
      //
      // Try in-memory first (fast); fall back to localStorage so snapshots
      // survive tab discards / browser reloads.
      // COD-187: mirror tabs never restore snapshots or cache — the frame
      // fetch below is the sole first paint (a scrollback-0 serialize is one
      // screen of stale content at best).
      const mirror = this._isMirrorSession(sessionId);
      let snapshot = mirror ? null : this._xtermSnapshots?.get(sessionId);
      if (snapshot && !this._isUsableXtermSnapshot(snapshot)) {
        this._xtermSnapshots?.delete(sessionId);
        snapshot = null;
      }
      if (!snapshot && !mirror) {
        try {
          const persisted = localStorage.getItem(`codeman-xs-${sessionId}`);
          if (persisted && this._isUsableXtermSnapshot(persisted)) {
            snapshot = persisted;
            // Hoist into in-memory cache for next time (delete-before-set keeps
            // the Map in LRU order so the just-used session isn't evicted first).
            this._xtermSnapshots?.delete(sessionId);
            this._xtermSnapshots?.set(sessionId, persisted);
          } else if (persisted) {
            localStorage.removeItem(`codeman-xs-${sessionId}`);
          }
        } catch (_e) {
          /* localStorage unavailable — proceed without snapshot */
        }
      }
      const sessionIsBusy = session && (session.status === 'busy' || session.status === 'working');
      let restoredSnapshot = false;
      if (snapshot && session?.mode !== 'shell' && (!sessionIsBusy || session?.mode === 'codex')) {
        _crashDiag.log(`SNAPSHOT_RESTORE: ${(snapshot.length/1024).toFixed(0)}KB`);
        this._setTerminalLoadState(sessionId, selectGen, 'replaying');
        this._resetTerminalForReplay();
        await new Promise((resolve) => this.terminal.write(snapshot, resolve));
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
        this.scrollToLastNonEmptyLine();
        _crashDiag.log('SNAPSHOT_RESTORE_DONE');
        // Snapshot restore is authoritative for Codex scrollback. Codex's TUI
        // current frame can omit earlier assistant output that xterm already
        // preserved, so the fetch below should update cache/state without
        // replacing this rendered snapshot.
        restoredSnapshot = true;
      }

      // Instant cache restore for IDLE sessions only.
      // For busy sessions, the cache is always stale — writing it first causes a
      // jarring double-render: stale content appears, then the terminal flashes
      // blank and rewrites with fresh data. Skip the cache and write the fresh
      // buffer once for a single clean transition.
      const cachedBuffer = mirror ? undefined : this.terminalBufferCache.get(sessionId);
      let clearedForBusy = false;
      if (mirror) {
        // COD-187: clear now; the frame fetch below paints the screen.
        this._resetTerminalForReplay();
        clearedForBusy = true;
      } else if (cachedBuffer && !sessionIsBusy && !restoredSnapshot) {
        _crashDiag.log(`CACHE_WRITE: ${(cachedBuffer.length/1024).toFixed(0)}KB`);
        this._setTerminalLoadState(sessionId, selectGen, 'replaying');
        this._resetTerminalForReplay();
        await this.chunkedTerminalWrite(cachedBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner);
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
        this.terminal.scrollToBottom();
        _crashDiag.log('CACHE_DONE');
      } else if (sessionIsBusy && !restoredSnapshot) {
        // Clear stale content immediately — fresh buffer is being fetched
        this._resetTerminalForReplay();
        clearedForBusy = true;
        _crashDiag.log('CACHE_SKIP_BUSY');
      }

      // Give TUI sessions a short chance to redraw after resize before the
      // fresh buffer fetch. Only needed when the resize actually changed
      // dimensions (a real SIGWINCH → Ink redraw); a same-size tab switch sent
      // no resize, so waiting would just add latency. Shell sessions never need
      // it, so terminal content can appear immediately when switching shells.
      if (session?.mode !== 'shell' && dimsChanged) {
        await new Promise((resolve) => setTimeout(resolve, TUI_REDRAW_SETTLE_MS));
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
      }

      this._setTerminalLoadState(sessionId, selectGen, 'fetching');
      _crashDiag.log('FETCH_START');
      const requestFullHistory = session?.mode !== 'shell' && !this._sessionsLoadedSincePageOpen.has(sessionId);
      // COD-187: mirror tabs fetch ONLY the current cursor-positioned frame.
      const terminalUrl = mirror
        ? `/api/sessions/${sessionId}/terminal?frame=1`
        : session?.mode === 'shell' || requestFullHistory
          ? `/api/sessions/${sessionId}/terminal`
          : `/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`;
      this._sessionsLoadedSincePageOpen.add(sessionId);
      const res = await fetch(terminalUrl);
      if (this._isStaleSelect(selectGen)) {
        this._clearTerminalLoadState(sessionId, selectGen);
        return;
      }
      const data = (await res.json())?.data ?? {};
      _crashDiag.log(`FETCH_DONE: ${data.terminalBuffer ? (data.terminalBuffer.length/1024).toFixed(0) + 'KB' : 'empty'} truncated=${data.truncated}`);

      if (data.terminalBuffer) {
        // Skip rewrite if fresh buffer matches cache — avoids visible clear+rewrite flash.
        // On slow connections (mobile 5G), the gap between clear() and chunkedWrite() is
        // very visible, causing the terminal to flash blank then repaint.
        // A restored Codex snapshot keeps the browser's richer scrollback ONLY
        // while it is provably not stale: either nothing new happened since the
        // cached canonical buffer, or live output is still streaming (busy) and
        // will reconcile the viewport. Inactive tabs unsubscribe from terminal
        // output, so the fetched frame is the only way an idle tab learns about
        // output produced while the user was away — preserving unconditionally
        // left tabs frozen on a mid-turn frame forever (COD-175).
        const canonicalUnchanged = data.terminalBuffer === cachedBuffer;
        // COD-92: byte-identical canonical buffer ⇒ keep the restored snapshot
        // for ANY mode (skip the clear+rewrite flash); busy allowance stays
        // codex-only. Predicate lives in terminal-ui.js (unit-tested).
        const preserveSnapshotScrollback = this._shouldPreserveSnapshotScrollback({
          restoredSnapshot,
          clearedForBusy,
          requestFullHistory,
          canonicalUnchanged,
          sessionIsBusy,
          mode: session?.mode,
        });
        const needsRewrite =
          clearedForBusy || (!preserveSnapshotScrollback && (restoredSnapshot || data.terminalBuffer !== cachedBuffer));
        if (needsRewrite) {
          _crashDiag.log(`REWRITE: ${(data.terminalBuffer.length/1024).toFixed(0)}KB`);
          this._setTerminalLoadState(sessionId, selectGen, 'replaying');
          this._resetTerminalForReplay();
          // Show truncation indicator if buffer was cut
          if (data.truncated) {
            this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
          }
          // Use chunked write for large buffers to avoid UI jank
          await this.chunkedTerminalWrite(data.terminalBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner);
          if (this._isStaleSelect(selectGen)) {
            this._clearTerminalLoadState(sessionId, selectGen);
            return;
          }
          // Ensure terminal is scrolled to bottom after buffer load
          this.terminal.scrollToBottom();
        }

        if (mirror) {
          // COD-187: frames are not cached (always refetched); remember the
          // painted frame so _refreshMirrorFrame can dedupe.
          this._lastMirrorFrame = { id: sessionId, buf: data.terminalBuffer };
        } else {
          // Update cache (cap at 20 entries)
          this.terminalBufferCache.set(sessionId, data.terminalBuffer);
          if (this.terminalBufferCache.size > 20) {
            // Evict oldest entry (first key in Map iteration order)
            const oldest = this.terminalBufferCache.keys().next().value;
            this.terminalBufferCache.delete(oldest);
          }
        }
      } else if (!cachedBuffer) {
        // No fresh buffer and no cache — clear any stale content
        this._resetTerminalForReplay();
        bufferWasEmpty = true;
        // COD-187: a mirror tab whose frame fetch came back degraded/empty
        // recovers from live repaints; nudge one frame retry for idle panes
        // that won't repaint on their own.
        if (mirror) {
          setTimeout(() => this._refreshMirrorFrame(sessionId), 2000);
        }
      }

      // Buffer load complete — unblock live SSE writes. chunkedTerminalWrite calls
      // _finishBufferLoad internally (discarding queued events to prevent duplicate
      // content); if we skipped the write (cache hit or empty), call it here.
      // COD-144: when the load painted nothing, FLUSH the queued events instead of
      // discarding — a new session's prompt arrives only as a queued SSE event.
      if (this._isLoadingBuffer) {
        this._finishBufferLoad(bufferLoadOwner, { flushQueued: bufferWasEmpty });
      }
      // Drop the guard so user input clears state normally
      this._restoringFlushedState = false;

      // Restore flushed offset and text for this session so the overlay positions
      // correctly even before the PTY echo arrives in the terminal buffer.
      if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
        this._localEchoOverlay.setFlushed(
          this._flushedOffsets.get(sessionId),
          this._flushedTexts?.get(sessionId) || '',
          false  // render=false: buffer just loaded, defer to rerender
        );
        // Trigger render after xterm.js finishes processing the buffer data.
        // terminal.write('', callback) fires the callback after ALL previously
        // queued writes have been parsed — so findPrompt() can find ❯ in the buffer.
        const zl = this._localEchoOverlay;
        this.terminal.write('', () => {
          if (zl.hasPending) zl.rerender();
        });
      }

      // Fire-and-forget resize to nudge Ink via SIGWINCH on real size changes.
      // Previously we also sent Ctrl+L (\x0c) here to force a full Ink redraw,
      // but Claude Code 2.x treats Ctrl+L as a two-step "clear conversation"
      // command — if a page refresh or SSE reconnect ran selectSession twice
      // within Claude's confirmation window, the second \x0c silently wiped the
      // conversation. Stale Ink frames in the tailed buffer are a cosmetic
      // annoyance that disappear on the user's next keypress; data loss is not
      // acceptable. Do NOT re-introduce Ctrl+L here.
      this.sendResize(sessionId);

      // Defer secondary panel updates so they don't block the main thread
      // after terminal content is already visible.
      const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
      idleCb(() => {
        // Guard against stale generation — user may have switched tabs again
        if (selectGen !== this._selectGeneration) return;

        // Update respawn banner
        if (this.respawnStatus[sessionId]) {
          this.showRespawnBanner();
          this.updateRespawnBanner(this.respawnStatus[sessionId].state);
          document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
          this.updateCountdownTimerDisplay();
          this.updateActionLogDisplay();
          if (Object.keys(this.respawnCountdownTimers[sessionId] || {}).length > 0) {
            this.startCountdownInterval();
          }
        } else {
          this.hideRespawnBanner();
          this.stopCountdownInterval();
        }

        // Update task panel if open
        const taskPanel = document.getElementById('taskPanel');
        if (taskPanel && taskPanel.classList.contains('open')) {
          this.renderTaskPanel();
        }

        // Update ralph state panel for this session
        const curSession = this.sessions.get(sessionId);
        if (curSession && (curSession.ralphLoop || curSession.ralphTodos)) {
          this.updateRalphState(sessionId, {
            loop: curSession.ralphLoop,
            todos: curSession.ralphTodos
          });
        }
        this.renderRalphStatePanel();

        // Update CLI info bar (mobile - shows Claude version/model)
        this.updateCliInfoDisplay();

        // Update project insights panel for this session
        this.renderProjectInsightsPanel();

        // Update subagent window visibility for active session
        this.updateSubagentWindowVisibility();

        // Load file browser if enabled
        this.showConfiguredFileBrowserPanel?.(sessionId);
      });

      _crashDiag.log('FOCUS');
      if (shouldFocusTerminal && this.terminal) this.terminal.focus();
      this.scrollToLastNonEmptyLine();
      // If we switched INTO this tab while the soft keyboard is already up, no
      // viewport-resize transition fires (handleViewportResize only runs
      // onKeyboardShow on a hidden→visible change), so the newly-active
      // session never gets that heal: fit() + scrollToBottom() + local-echo
      // overlay rerender() + one-shot SIGWINCH. Without it the overlay renders
      // against stale, off-bottom state and typed input stays INVISIBLE until
      // the user manually toggles the keyboard. Replicate the heal here so
      // local echo paints on the first keystroke after a keyboard-up tab switch.
      if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) {
        KeyboardHandler.onKeyboardShow();
      }
      this._clearTerminalLoadState(sessionId, selectGen);
      this._scheduleTerminalRepaint();
      _crashDiag.log(`SELECT_DONE: ${(performance.now() - _selStart).toFixed(0)}ms`);
      console.log(`[CRASH-DIAG] selectSession DONE: ${sessionId.slice(0,8)} in ${(performance.now() - _selStart).toFixed(0)}ms`);
    } catch (err) {
      if (this._isLoadingBuffer) this._finishBufferLoad(bufferLoadOwner);
      this._restoringFlushedState = false;
      this._setTerminalLoadState(sessionId, selectGen, 'failed');
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    // If the deleted session is currently being renamed, abort the rename
    // so the inline <input> doesn't ghost as a stale tab on screen.
    if (this._activeRename?.sessionId === sessionId) {
      this._activeRename.cancel();
    }
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);
    this._xtermSnapshots?.delete(sessionId);
    try { localStorage.removeItem(`codeman-xs-${sessionId}`); } catch {}

    this._flushedOffsets?.delete(sessionId);
    this._flushedTexts?.delete(sessionId);
    // Drop any durably-queued input for a session that's actually gone (deleted/
    // exited). Not a lost prompt — the target no longer exists. Only reached on
    // real session removal, never on a tab switch.
    this._pendingDeliveries?.delete(sessionId);
    this._seqCounters?.delete(sessionId);
    this._postDraining?.delete(sessionId);
    this._persistReliableState();
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.attachmentHistoryCounts.delete(sessionId);
    if (this.attachmentHistoryDrawerOpen && this.activeSessionId === sessionId) {
      this.closeAttachmentHistory?.();
    }
    this.terminalLoadStates.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
    this.closeSessionAttachmentCards(sessionId);
    this.closeSessionSubagentWindows(sessionId, true);

    // Clean up idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
    // Clean up respawn state
    delete this.respawnStatus[sessionId];
    delete this.respawnTimers[sessionId];
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
  }

  async closeSession(sessionId, killMux = true) {
    try {
      await this._apiDelete(`/api/sessions/${sessionId}?killMux=${killMux}`);
      this._cleanupSessionData(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        // Select another session or show welcome (use sessionOrder for consistent ordering)
        if (this.sessionOrder.length > 0 && this.sessions.size > 0) {
          const nextSessionId = this.sessionOrder[0];
          this.selectSession(nextSessionId);
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killMux) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
    }
  }

  // Request confirmation before closing a session
  requestCloseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.pendingCloseSessionId = sessionId;

    // Show session name in confirmation dialog
    const name = this.getSessionName(session);
    const sessionNameEl = document.getElementById('closeConfirmSessionName');
    sessionNameEl.textContent = name;

    // Update kill button text based on session mode
    const killTitle = document.getElementById('closeConfirmKillTitle');
    if (killTitle) {
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : session.mode === 'codex'
          ? 'Kill Tmux & Codex'
          : session.mode === 'gemini'
            ? 'Kill Tmux & Gemini'
            : session.mode === 'agy'
              ? 'Kill Tmux & Agy'
              : 'Kill Tmux & Claude Code';
    }

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killMux = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killMux);
    }
  }

  nextSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[nextIndex]);
  }

  prevSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const prevIndex = (currentIndex - 1 + this.sessionOrder.length) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[prevIndex]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('codeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // Upload
  // ═══════════════════════════════════════════════════════════════

  openUploadPopup() {
    window.open('/upload.html', 'codeman-upload', 'width=520,height=600,resizable=yes');
  }

  // ═══════════════════════════════════════════════════════════════
  // Ralph Loop Wizard (methods in ralph-wizard.js)
  // ═══════════════════════════════════════════════════════════════

  // Wizard state (initialized here, methods loaded from ralph-wizard.js)
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: false,
    generatedPlan: null,
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed',
    existingPlan: null,
    useExistingPlan: false,
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  // ═══════════════════════════════════════════════════════════════
  // Kill Sessions
  // ═══════════════════════════════════════════════════════════════

  renameActiveTab() {
    if (!this.activeSessionId) return;
    this.startInlineRename(this.activeSessionId);
  }

  async killActiveSession() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }
    await this.closeSession(this.activeSessionId);
  }

  async killAllSessions() {
    if (this.sessions.size === 0) return;

    if (!confirm(`Kill all ${this.sessions.size} session(s)?`)) return;

    try {
      await this._apiDelete('/api/sessions');
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.terminalLoadStates.clear();
      this._xtermSnapshots?.clear();
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('codeman-xs-')) localStorage.removeItem(k);
        }
      } catch {}
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.respawnStatus = {};
      this.respawnCountdownTimers = {};
      this.respawnActionLogs = {};
      this.stopCountdownInterval();
      this.hideRespawnBanner();
      this.renderSessionTabs();
      this.terminal.clear();
      this.showWelcome();
      this.showToast('All sessions killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill sessions', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Timer
  // ═══════════════════════════════════════════════════════════════

  showTimer() {
    document.getElementById('timerBanner').style.display = 'flex';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.currentRun || this.currentRun.status !== 'running') return;

    const now = Date.now();
    const remaining = Math.max(0, this.currentRun.endAt - now);
    const total = this.currentRun.endAt - this.currentRun.startedAt;
    const elapsed = now - this.currentRun.startedAt;
    const percent = Math.min(100, (elapsed / total) * 100);

    document.getElementById('timerValue').textContent = this.formatTime(remaining);
    document.getElementById('timerProgress').style.width = `${percent}%`;
    document.getElementById('timerMeta').textContent =
      `${this.currentRun.completedTasks} tasks | $${this.currentRun.totalCost.toFixed(2)}`;
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;
    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, { method: 'DELETE' });
    } catch (err) {
      this.showToast('Failed to stop run', 'error');
    }
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tokens
  // ═══════════════════════════════════════════════════════════════

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    this._clearTimer('_updateTokensTimeout');
    this._updateTokensTimeout = setTimeout(() => {
      this._updateTokensTimeout = null;
      this._updateTokensImmediate();
    }, 200);
  }

  _updateTokensImmediate() {
    // Use global stats if available (includes deleted sessions)
    let totalInput = 0;
    let totalOutput = 0;
    if (this.globalStats) {
      totalInput = this.globalStats.totalInputTokens || 0;
      totalOutput = this.globalStats.totalOutputTokens || 0;
    } else {
      // Fallback to active sessions only
      this.sessions.forEach(s => {
        if (s.tokens) {
          totalInput += s.tokens.input || 0;
          totalOutput += s.tokens.output || 0;
        }
      });
    }
    const total = totalInput + totalOutput;
    this.totalTokens = total;
    const display = this.formatTokens(total);

    // Estimate cost from tokens (more accurate than stored cost in interactive mode)
    const estimatedCost = this.estimateCost(totalInput, totalOutput);
    const tokenEl = this.$('headerTokens');
    if (tokenEl) {
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      tokenEl.textContent = total > 0
        ? (showCost ? `${display} tokens · $${estimatedCost.toFixed(2)}` : `${display} tokens`)
        : '0 tokens';
      tokenEl.title = this.globalStats
        ? `Lifetime: ${this.globalStats.totalSessionsCreated} sessions created${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`
        : `Token usage across active sessions${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`;
    }
  }

}

// ═══════════════════════════════════════════════════════════════
// Module Init — localStorage migration and app start
// ═══════════════════════════════════════════════════════════════

// Migrate legacy localStorage keys (claudeman-* → codeman-*)
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('claudeman-') || key.startsWith('claudeman_'))) {
      const newKey = key.replace(/^claudeman[-_]/, (m) => 'codeman' + m.charAt(m.length - 1));
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch {}

// Initialize — use DOMContentLoaded to ensure all defer'd mixin modules
// (terminal-ui.js, settings-ui.js, etc.) have executed their Object.assign
// onto CodemanApp.prototype before we instantiate.
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new CodemanApp();
  window.app = app;
});
window.MobileDetection = MobileDetection;
