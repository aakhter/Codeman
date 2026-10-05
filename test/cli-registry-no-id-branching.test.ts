/**
 * @fileoverview Static guard: no code outside the stock catalog branches on a CLI's ID.
 *
 * The whole point of the registry is that behaviour which differs between CLIs is DATA (a
 * `CliEntry` field) or a NAMED PROFILE selected by a field — never `mode === 'codex'`. A
 * single reintroduced id-check is how the old shape grows back, one "just this once" at a
 * time, until adding a CLI means editing forty files again.
 *
 * This guard was cited by name in three separate file headers of an earlier attempt at this
 * refactor and never actually written — and in its absence four id-branches survived that
 * migration, one of them dead code sitting directly under the generic check that replaced it.
 * So the guard is not decoration: it is the thing that makes the rule true rather than
 * aspirational.
 *
 * ## What is allowlisted, and why an allowlist rather than zero
 *
 * Some branches are not CLI-behaviour branches at all, and forcing them through a capability
 * would make the code worse, not better. Each entry below carries its reason. The categories:
 *
 *  - **Legacy `<Mode>Config` plumbing.** `POST /api/sessions` has carried named per-CLI
 *    config objects since before the registry, and `docs/versioning-policy.md` makes that
 *    wire shape public. Selecting `codexConfig` for codex is a fact about the HTTP API, not
 *    about codex, and the `Session` constructor mirrors it. The registry already owns the
 *    translation (`launch.legacyConfigField`); collapsing the constructor too is a public-API
 *    change and belongs in its own PR.
 *  - **Claude's remote/docker command construction.** Claude's pane command varies with the
 *    session's permission mode and its docker form is `--session-id … || resume`, semantics
 *    no other CLI has and a static `overlays.command` string cannot express.
 *  - **Genuinely per-CLI prose.** One error message that explains why a deepseek session in
 *    particular will never deliver a `stop` signal, and the literal strings a CLI's own TUI
 *    paints (codex's `Working (2s • esc to interrupt)`, opencode's Bubble Tea spinner) — there
 *    is no boolean a capability could carry, and the frames of a CLI nobody has watched cannot
 *    be invented.
 *  - **Two conversation-identity MECHANISMS.** Claude's identity arrives over its own
 *    SessionStart hook and is adopted into session state; codex's is recovered by scanning
 *    rollout files on disk and disambiguated against sibling panes' submit times. A field whose
 *    value was "hook" for one and "scan \$CODEX_HOME" for the other would just be naming the two
 *    code paths, which is a branch with extra steps. (COD-416 wave 4 DID convert the part of
 *    this area that was genuinely data: the checkpoint terminal grammar — which glyph means
 *    ready, which frame means working — is now `capabilities.checkpoint`.)
 *
 * ⚠️ Adding an entry here is a decision, not a formality. If the branch is about what a CLI
 * CAN DO, it belongs in `CliCapabilities` instead — and if it needs to run code, in
 * `config/cli-registry/profiles.ts` as a named profile.
 *
 * Port: none (pure static analysis).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Files exempt from the scan entirely, because naming CLI ids IS their job.
 *
 * `stock.ts` is the catalog. The per-CLI resolver modules are each ABOUT one CLI and look up
 * their own entry by id — the same reason the catalog may, and the reason they are not a
 * loophole: they resolve a binary, they decide no behaviour.
 */
const EXEMPT_FILES = new Set(
  [
    'config/cli-registry/stock.ts',
    'utils/claude-cli-resolver.ts',
    'utils/opencode-cli-resolver.ts',
    'utils/codex-cli-resolver.ts',
    'utils/gemini-cli-resolver.ts',
    'utils/antigravity-cli-resolver.ts',
    'utils/pi-cli-resolver.ts',
    'utils/grok-cli-resolver.ts',
    'utils/deepseek-cli-resolver.ts',
    // Names the deepseek launcher profile's implementation; keyed by profile, not by id.
    'utils/cli-launcher.ts',
  ].map((p) => p.split('/').join(sep))
);

/**
 * Specific surviving branches, each with the reason it is not a capability.
 * Keyed `<relative path>::<the matched expression>`.
 */
const ALLOWED_BRANCHES: Record<string, string> = {
  // COD-468 landed conversation-recovery integrations alongside COD-486. These
  // select exact on-disk identity formats or the existing public config fields;
  // they do not define CLI capabilities (same category as the identity entries below).
  "reboot-restore.ts::mode === 'codex'":
    'Codex rollout UUID evidence versus the Claude conversation chain in boot reconciliation',
  "session-recovery-names.ts::mode === 'codex'":
    'Codex session_index and rollout identity metadata used for recovery display names',
  "session-recovery-names.ts::mode === 'claude'":
    'Claude transcript conversation-name metadata selected by its exact conversation identity',
  "session-recovery-preview.ts::mode === 'codex'":
    'Codex rollout-path attribution and its response_item user-prompt transcript format',
  "session-recovery-preview.ts::mode === 'claude'":
    'Claude transcript-path attribution and sessionId/cwd/isSidechain identity proof',
  "session-recovery.ts::mode === 'codex'":
    'Allowlisted native conversation UUID from the public codexConfig resumeSessionId field',
  "session-recovery.ts::mode === 'claude'":
    'Newest adopted Claude conversation-chain identity rather than the original tab UUID',
  "web/routes/reboot-restore-routes.ts::mode === 'codex'":
    'Existing public codexConfig versus top-level Claude resumeSessionId launch-field plumbing',
  "web/routes/session-recovery-routes.ts::mode === 'codex'":
    'Refresh missing local Codex identity through the verified rollout-file resolver',
  "web/routes/session-recovery-routes.ts::mode === 'claude'":
    'Refresh local Claude identity through the adopted conversation chain and transcript evidence',

  // ── COD-416 wave 4: the last two, triaged rather than baselined ─────────────────────
  //
  // The DOWNSTREAM PRE-REGISTRY BASELINE block that stood here is GONE, and with it the
  // `PRE_REGISTRY` placeholder: all 53 keys are now either registry data or an entry with its
  // own stated reason. Wave 4 converted the checkpoint TERMINAL GRAMMAR — which glyph means
  // "ready" and which frame means "working" — into `capabilities.checkpoint` plus a named
  // CHECKPOINT_FRAME_PROFILES classifier, and triaged what remained.
  //
  // ⚠️ What remains under these two keys is NOT leftover branching: it is the two CONVERSATION
  // IDENTITY integrations, which are different mechanisms rather than different values of one
  // mechanism. Claude's identity arrives over its own SessionStart HOOK and is adopted into
  // session state; codex's is recovered by scanning ROLLOUT FILES on disk and disambiguated
  // against sibling panes' submit times. There is no field whose value could be "hook" for one
  // and "scan ~/.codex" for the other without that field simply naming the two code paths —
  // which is a branch with extra steps. Their negated twins are already allowlisted directly
  // below for exactly this reason, and this is the same family.

  // Claude session identity + the direct-PTY path. Every site asks "is this Claude": whether
  // its SessionStart hook has reported in, whether its authoritative conversation id has been
  // adopted, and the terminal write + resume-id preservation for the direct-PTY fallback —
  // which exists only for claude, the one CLI Codeman ever runs without tmux. The `❯` glyph
  // and working-frame that USED to be in this list are now data (`capabilities.checkpoint`).
  "session.ts::mode === 'claude'":
    "claude's SessionStart-hook readiness, adopted conversation identity, and the direct-PTY " +
    "fallback — identity mechanics, not a capability (twin of the `mode !== 'claude'` entry below)",

  // Codex conversation identity + its own TUI prose. The identity sites recover a conversation
  // by scanning $CODEX_HOME rollout files, arm a fresh-thread baseline around `/new`, and
  // publish submit times to a cross-session map so a sibling codex pane's turn is not mistaken
  // for this one's. The two frame sites are per-CLI PROSE, the same category as the
  // `session.ts::mode === 'opencode'` entry below and in one case the same function. The
  // remaining site is a `CODEMAN_CODEX_RAW_LOG=1` debugging hook for codex's stacked status bar.
  "session.ts::mode === 'codex'":
    'codex rollout-file conversation identity, cross-session submit disambiguation, and its own ' +
    "TUI frame prose + raw-log debug hook (twin of the `mode !== 'codex'` entry below)",

  // tmux-manager.ts's last key, after wave 3e moved the remote and docker command chains onto
  // registry data. Everything left is LOCAL-only and none of it is a "how does this CLI launch"
  // question: two sites re-check the COD-392 grant before honouring an owner-authored command
  // line (the value itself is `launch.rawCommandField` data now; the GRANT check is a
  // multi-user authorization question about shell text, not about codex), four are COD-98 /
  // COD-254 Headroom routing — the same lane split already allowlisted for
  // `config/headroom-routing.ts`, where claude routes by env var and codex by a config.toml
  // patch — one is codex's remote resume-TEMPLATE recovery, and one matches the literal text
  // codex prints when a skill is invoked.
  "tmux-manager.ts::mode === 'codex'":
    'COD-392 owner-command grant re-check, COD-98 Headroom config.toml routing, remote ' +
    "resume-template recovery, and codex's own skill-invocation prose — all local-only",

  // ── COD-416 wave 1: triaged out of the baseline above ───────────────────────────────
  //
  // Converted to DATA (no entry needed, the branch is gone):
  //   web/session-wait-registry.ts `approvalsAvailableForMode` → `capabilities.approvals`,
  //   a fourth independent set that lines up with neither `hooks` nor `external`.
  //
  // The rest are category (2): each is a genuine per-CLI question, not a capability, and
  // each carries its own reason below rather than a shared placeholder.

  // --- Read My Mind / intent capture: strict per-provider lanes, claude-only by design ---
  //
  // Same reasoning as the `web/server.ts::mode !== 'claude'` entry further down, and the
  // reason CLAUDE.md tells you NOT to reach for `hooksAvailableForMode()` here: these read
  // Claude's OWN transcript, and the local-Codex lane reads a strictly-owned codex rollout.
  // A capability would have to merge two deliberately separate provider lanes.
  "web/routes/readmymind-routes.ts::mode === 'claude'": "Read My Mind claude lane: reads Claude's own transcript",
  "web/routes/readmymind-routes.ts::mode === 'codex'":
    'Read My Mind local-Codex lane: strictly-owned codex rollout, no cross-provider fallback',
  "session-agent-activity-coordinator.ts::mode === 'claude'":
    'agent observation is keyed on claudeSessionId — a Claude transcript fact, not a capability',
  "hooks-config.ts::mode !== 'claude'":
    "verifies CLAUDE's own SessionStart hook identity; a non-claude mode has no such hook to verify",

  // --- Headroom context-compression routing (COD-98) ---
  //
  // Not "which CLIs support a proxy" but "which two CLIs Codeman knows how to point at one",
  // and the two mechanisms are different in kind: claude takes ANTHROPIC_BASE_URL via env
  // injection, codex takes a config.toml patch. A boolean capability could not say which.
  "config/headroom-routing.ts::mode !== 'claude'": 'Headroom claude lane: ANTHROPIC_BASE_URL env injection (COD-98)',
  "config/headroom-routing.ts::mode === 'claude'": 'Headroom claude lane: ANTHROPIC_BASE_URL env injection (COD-98)',
  "config/headroom-routing.ts::mode === 'codex'":
    'Headroom codex lane: config.toml patch, a different mechanism (COD-98)',

  // --- Codex-specific features whose subject IS the codex artifact format ---
  "web/routes/file-routes.ts::mode !== 'codex'":
    "file-uri previews decode codex's own artifact URI scheme; the 403 names the mode in its prose",
  "session-recovery.ts::mode !== 'codex'":
    'recovers a custom CODEX launch string against a codex resume template; no other CLI has one',

  // --- Approvals ingestion path split (COD-328) ---
  //
  // NOT a duplicate of `capabilities.approvals` above: that says WHETHER a mode has items,
  // this says WHICH path builds them. Claude's come from hook events, so the transition
  // path must exclude it or a claude turn-end would double-file an item the hook already
  // filed. Both halves of the pair are claude-shaped questions, not capability ones.
  "web/session-listener-wiring.ts::mode !== 'claude'":
    "transition-inferred idle is for the modes WITHOUT hooks; claude's items come from hook events",

  // --- Legacy <Mode>Config plumbing (public wire shape, see the header) ---
  //
  // Same category as the `===` block below, reached from the recovery and validation paths.
  "native-session-identity.ts::mode === 'codex'": 'Codex rollout lookup for native resume identity',
  "native-session-identity.ts::mode === 'opencode'": 'OpenCode session lookup for native resume identity',
  "native-session-identity.ts::mode !== 'codex'": 'Codex rollout scan reuse for native resume identity',
  "web/session-recovery-service.ts::mode === 'codex'": 'legacy Codex resume config slot',
  "web/session-recovery-service.ts::mode === 'opencode'": 'legacy OpenCode resume config slot',
  "web/server.ts::'codex', 'opencode'].includes(":
    'native identity capture is implemented for these transcript formats',

  // ── COD-416 wave 2: session.ts ──────────────────────────────────────────────────────
  //
  // Converted to DATA (no entry needed, the branches are gone): `_applyNativeResumeIdForResume`
  // read codex/opencode/gemini/antigravity out of a four-way chain that was a second copy of
  // `legacyConfigField` + the `resumeId` alias. It now reads `legacyResumeSlot()`, which
  // removed BOTH the gemini and antigravity keys from this file outright.

  // Per-CLI TUI frame regexes. `detectExternalCliWorkingFrame` matches the literal strings
  // codex's and opencode's TUIs paint ("Working (2s • esc to interrupt)", Bubble Tea's
  // spinner+timer). That is per-CLI PROSE, not a behavioural switch: there is no boolean a
  // capability could carry, and the pattern for a CLI Codeman has never observed cannot be
  // invented. Moving these into registry `patterns` is its own change with its own risk —
  // they feed idle detection — and is deliberately not bundled into a refactor.
  "session.ts::mode === 'opencode'": "opencode's own TUI working-frame regex; per-CLI prose, not a capability",

  // Claude session-identity + direct-PTY checkpoint. Both sites ask "is this Claude", whose
  // SessionStart hook and `❯` prompt transition are what the code waits on: a non-claude mode
  // is hook-ready by definition (there is no Claude hook to wait for), and the instant-clear
  // generation check only exists for the direct-PTY Claude fallback. Same family as the
  // `hooks-config.ts` and `web/server.ts::mode !== 'claude'` entries.
  "session.ts::mode !== 'claude'":
    'Claude SessionStart-hook readiness and the direct-PTY checkpoint clear — claude-identity questions',

  // Codex provider identity + resolved launch command, both server-only persistence.
  // ⚠️ The `getResolvedCodexCommandForPersist` site is COD-392's `baseCommand`, which COD-416
  // itself records as having to STAY code-level: it is a complete server-resolved shell
  // command, and the argv engine forbids shell text by design, so there is no registry shape
  // for it. The identity site is the Read My Mind codex lane (see readmymind-routes entries).
  "session.ts::mode !== 'codex'":
    'codex provider identity + COD-392 baseCommand persistence; the argv engine cannot express a shell command',

  // COD-189 shell burst tracking, on the SHARED output path because shell sessions never pass
  // through the interactive-session hooks. Same reason as the session-routes.ts shell entry:
  // this is about tmux pane history vs byte history, not about any CLI's behaviour.
  "session.ts::mode === 'shell'": 'COD-189 shell burst tracking on the shared output path',

  // ── COD-416 wave 3a: the stale external-CLI mode lists (Q23, approved) ──────────────
  //
  // respawn-routes.ts (3 gates), ralph-routes.ts (1) and server.ts (5 restore chains) each
  // named a hardcoded `opencode|codex|gemini(|antigravity)` list while their own comments
  // said "not supported for EXTERNAL CLI sessions". The list was the external set as it stood
  // when antigravity was added (dda03c3a) and was never extended for pi/grok/deepseek/omp —
  // so all nine sites are now `isExternalCliMode()`, deleting 9 keys outright.
  //
  // ⚠️ A DELIBERATE, APPROVED BEHAVIOUR CHANGE, not a refactor: respawn newly refuses
  // pi/grok/deepseek/omp and ralph newly refuses those plus antigravity. They were never
  // really supported — respawn drives Claude-shaped `/clear` + re-prompt and ralph parses
  // Claude's todo output, neither of which an external CLI understands.
  //
  // ⚠️ `!isExternalCliMode()` and NOT `capabilities.respawn`/`.ralph`: shell is `false` for
  // both in the registry but is not an external CLI, and shell respawn/ralph work today.
  // Gating on the capability would have silently killed them — a regression dressed up as a
  // cleanup, which is exactly what the capability's name invites you to do.

  // With those chains gone, this key's only remaining sites are the Read My Mind local-Codex
  // provider-recovery helpers (`resolveRestoredCodexProviderIdentity` and its recovery
  // sibling) — the same strict per-provider lane as the readmymind-routes entries above, and
  // an early return for a mode that has no codex rollout to recover.
  //
  // It was blocked behind Q23 purely by the `file::expression` granularity limit: one key,
  // two unrelated uses. Removing the chains is what made it allowlistable on its own merits.
  "web/server.ts::mode !== 'codex'":
    'Read My Mind local-Codex provider identity/recovery; a non-codex session has no rollout to recover',

  // --- Capture-canonical terminal reload (COD-189) ---
  //
  // About tmux pane history vs byte history for a SHELL pane, not about any CLI's
  // behaviour: a fast shell burst makes byte history sparse while the pane history stays
  // contiguous. There is no CLI capability being asked about here.
  "web/routes/session-routes.ts::mode === 'shell'": 'COD-189 capture-canonical full reload for shell panes',

  // --- Legacy <Mode>Config plumbing (public wire shape, see the header) ---
  "web/routes/session-routes.ts::mode === 'opencode'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'codex'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'gemini'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'antigravity'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'pi'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'grok'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'deepseek'": 'legacy <Mode>Config plumbing',
  "web/server.ts::mode === 'opencode'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'codex'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'gemini'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'antigravity'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'pi'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'grok'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'deepseek'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'omp'": 'legacy <Mode>Config plumbing (session recovery)',

  // --- Claude's remote/docker command construction ---
  "tmux-manager.ts::mode === 'claude'":
    "claude's remote pane command carries per-session permission flags, and its docker form is " +
    '`--session-id … || resume`; neither fits a static overlays.command string',
  "tmux-manager.ts::mode === 'omp'":
    'remote omp respawn needs the pinned/continue --resume override threaded through ' +
    '(resumeSessionId/ompConfig), which the static overlays.remote.command string has no ' +
    'room for; the command itself is still rendered through buildSpawnCommandFromRegistry, ' +
    'the same mode-agnostic engine local/docker spawns use — only the BRANCH is per-mode',

  // --- Per-CLI prose and launch handling not yet generalised ---
  "web/session-wait-registry.ts::mode === 'deepseek'":
    'an error message explaining why THIS mode in particular will never deliver a stop signal',
  "web/routes/approval-routes.ts::mode === 'deepseek'":
    'the DeepSeek status bridge is the only non-claude source of approval items',
  "cron/cron-service.ts::mode === 'claude'": 'cron launch handling, not yet generalised',
  "cron/cron-service.ts::mode === 'shell'": 'cron launch handling, not yet generalised',
  "web/routes/session-routes.ts::mode === 'claude'": 'docker case bookkeeping keyed on the claude conversation id',
  "cli.ts::mode === 'shell'": 'a CLI-table label, not behaviour',

  // --- Negated forms surfaced when BRANCH_PATTERN widened past `===` (see its comment) ---
  //
  // None of these is a regression: every one predates the registry and survived the
  // conversion only because the guard could not see `!==`. They are listed here with reasons
  // rather than silently converted, because each would change behaviour or invent a
  // capability field, and this change is meant to change nothing a user can see.

  // Read My Mind + intent capture read CLAUDE's OWN transcript, so `mode === 'claude'` is
  // the right question and `hooksAvailableForMode()` is NOT — once `deepseek` earned a yes
  // there, the shared predicate silently widened both to a mode with no transcript to read.
  // CLAUDE.md documents this as deliberate and `test/deepseek-mode.test.ts` pins it, so a
  // capability here would be actively wrong.
  "web/server.ts::mode !== 'claude'":
    "intent capture reads Claude's own transcript, and the recovered-workspace hook sweep " +
    'writes .claude hooks — both are claude questions, not capability ones (see CLAUDE.md)',

  // The TUI is a CLIENT of the server, and these two are about what it can offer for a row:
  // resume builds a `claude --resume`, and the mode badge is suppressed for the default mode
  // purely so the common case reads clean. The badge one is cosmetic and not a capability at
  // all; the resume one would need a "resumable from a claude transcript" field that nothing
  // else would read.
  "tui/tui-app.ts::mode !== 'claude'": 'TUI resume builds a claude --resume; claude-transcript-only by construction',
  "tui/tui-render.ts::mode !== 'claude'": 'cosmetic: suppress the mode badge for the default mode',

  // Push approve/deny BUTTONS are withheld for dsh because the answer route refuses
  // keystrokes for its dialogs (third-party TUI, unmeasured contract) — a button whose
  // answer would be refused is worse than none. Arguably wants an "answerable dialogs"
  // capability; deliberately not invented here.
  "web/routes/hook-event-routes.ts::mode !== 'deepseek'":
    'push buttons withheld where the answer route refuses keystrokes',

  // Legacy <Mode>Config plumbing, same category as the `===` entries above.
  "web/routes/session-routes.ts::mode !== 'omp'": 'legacy <Mode>Config plumbing (resolveOmpConfigForCreate)',

  // ⚠️ Scaffolded-case hooks. This chain excludes seven CLIs but NOT `deepseek`, while its
  // own comment says DeepSeek uses its own system — so a scaffolded deepseek case gets a
  // Claude hooks block written into it. That inconsistency is UPSTREAM's and predates this
  // change; expressing the chain as a capability would have to pick a side and would
  // therefore be a behaviour change. Left exactly as found, and named here so it is visible.
  "web/routes/session-routes.ts::mode !== 'opencode'":
    'scaffolded-case hooks + the COD-91 self-heal skip; the chain omits deepseek upstream, ' +
    'so any capability form would change behaviour — see PR discussion',
  "web/routes/session-routes.ts::mode !== 'codex'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'gemini'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'antigravity'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'pi'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'grok'": 'scaffolded-case hooks (see the opencode entry)',
};

/** Every stock CLI id, derived rather than restated so a new entry is covered automatically. */
const IDS = STOCK_CLIS.map((e) => e.id as string);
const ID_ALT = IDS.join('|');

/**
 * The shapes an id-branch actually takes, all four of them.
 *
 * ⚠️ An earlier version of this guard matched `===` ONLY, and that was not a small gap: the
 * refactor it guards converted the `===` sites and left the negated ones, so 36
 * `mode !== '<id>'` branches survived it — 28 in session-routes.ts alone, including a
 * seven-mode chain auto-enabling Ralph under a comment asking the next person to keep it in
 * step with a predicate BY HAND, while the sibling quick-start path already read
 * `capabilities.ralph`. A guard that sees half the shapes reports a count measured over the
 * half it happens to catch.
 *
 * `switch`/`case` and `[...].includes(mode)` are here for the same reason: each is a way of
 * writing the banned rule that the narrower pattern could not see.
 */
const BRANCH_PATTERN = new RegExp(
  [
    // mode === 'codex'  /  mode !== 'codex'
    `\\b(?:mode|id|agentType)\\s*[!=]==\\s*'(?:${ID_ALT})'`,
    // case 'codex':
    `\\bcase\\s+'(?:${ID_ALT})'\\s*:`,
    // ['codex', 'gemini'].includes(mode) — the id list IS the branch, wherever `mode` sits
    `'(?:${ID_ALT})'\\s*(?:,\\s*'(?:${ID_ALT})'\\s*)*\\]\\s*\\.includes\\(`,
  ].join('|'),
  'g'
);

/**
 * BLANK comment lines before scanning, rather than dropping them. Comments legitimately quote
 * the very pattern being banned — several of them explain WHY a branch was removed — and
 * flagging those would push the next author to delete the explanation rather than the code.
 *
 * ⚠️ Blanking rather than removing is what keeps reported line numbers pointing at the real
 * file. Dropping the lines shifted every finding upward by however many comments preceded it,
 * so the guard's own diagnostic sent you to the wrong place — which for a rule about not
 * writing a branch is exactly the moment you need the right one.
 */
function uncommented(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  expression: string;
  line: number;
  key: string;
}

function scan(): { findings: Finding[]; filesScanned: number } {
  const findings: Finding[] = [];
  const files = walk(SRC);
  let scanned = 0;
  for (const full of files) {
    const rel = relative(SRC, full);
    if (EXEMPT_FILES.has(rel)) continue;
    scanned++;
    const lines = uncommented(readFileSync(full, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      BRANCH_PATTERN.lastIndex = 0; // shared /g regex — see utils/regex-patterns.ts
      for (const match of line.matchAll(BRANCH_PATTERN)) {
        const expression = match[0].replace(/\s+/g, ' ').replace(/^(?:id|agentType)/, 'mode');
        const posix = rel.split(sep).join('/');
        findings.push({ file: posix, expression, line: i + 1, key: `${posix}::${expression}` });
      }
    });
  }
  return { findings, filesScanned: scanned };
}

const { findings, filesScanned } = scan();

describe('no CLI-id branching outside the stock catalog', () => {
  it('scans a meaningful number of source files (sanity)', () => {
    // If this collapses toward zero the walker or the exemption list drifted and every
    // assertion below would pass vacuously. Fix the scanner, do not delete the test.
    expect(filesScanned).toBeGreaterThan(100);
  });

  it('builds its id list from the live catalog (sanity)', () => {
    expect(IDS).toContain('claude');
    expect(IDS).toContain('deepseek');
    expect(IDS.length).toBeGreaterThanOrEqual(9);
  });

  it('still detects a branch when one exists (anti-vacuity)', () => {
    // Proves the pattern actually matches every shape it is meant to ban, so a regex typo
    // cannot silently turn this whole file into a no-op. One case per alternative, because
    // the `===`-only version of this test passed happily while `!==` went unseen.
    const samples = [
      "if (session.mode === 'codex') { doSomething(); }",
      "if (mode !== 'shell' && mode !== 'deepseek') { doSomething(); }",
      "switch (mode) { case 'gemini': return 1; }",
      "if (['codex', 'gemini'].includes(mode)) { doSomething(); }",
    ];
    for (const sample of samples) {
      BRANCH_PATTERN.lastIndex = 0;
      expect(sample.match(BRANCH_PATTERN), `pattern missed: ${sample}`).not.toBeNull();
    }
    BRANCH_PATTERN.lastIndex = 0;
    expect(uncommented("  // mode === 'codex'\ncode();").match(BRANCH_PATTERN)).toBeNull();
  });

  it('has no unapproved id branches', () => {
    const offenders = findings.filter((f) => !(f.key in ALLOWED_BRANCHES));
    const detail = offenders.map((f) => `  ${f.file}:${f.line}  ${f.expression}`).join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} CLI-id branch(es) outside the stock catalog:\n${detail}\n\n` +
            'Two ways out, in order of preference:\n' +
            '  1. Express the difference as data on the CliEntry (a CliCapabilities field), or as a\n' +
            '     NAMED PROFILE in config/cli-registry/profiles.ts if it genuinely needs to run code.\n' +
            '  2. If it is not a CLI-behaviour branch at all, add it to ALLOWED_BRANCHES in this file\n' +
            "     WITH the reason. Read this file's header before choosing option 2."
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted branch that no longer exists is a lie about the codebase, and the next
    // person to reintroduce that exact branch would sail straight through.
    const present = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED_BRANCHES).filter((key) => !present.has(key));
    expect(stale, `ALLOWED_BRANCHES entries no longer present — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

describe('declared-for-later fields', () => {
  /**
   * The fields `CliEntry`'s header declares as not-yet-read. Each is frontend behaviour, and
   * the frontend is untouched by this change.
   *
   * This is here so the list cannot quietly GROW. An unread field is a promise the code does
   * not keep, and the failure mode is a reader trusting one: the next person sees
   * `echo.policy: 'buffer'` on an entry and assumes the terminal honours it. Adding a field
   * nobody reads should be a decision someone makes on purpose, which means updating this
   * list — and wiring one up should make its line here fail, which is the good direction.
   */
  const DECLARED_FOR_LATER = [
    'accent',
    'capabilities.echo',
    'capabilities.keyboardAccessory',
    'capabilities.maxFrameBytes',
    // The Docker credential-seeding path still reads its own CRED_STORES table: this shape
    // allows ONE store per CLI and the live table needs two for gemini. See CliOverlays.
    'overlays.credStore',
  ];

  /** Read every `.ts` under src/, minus the registry itself (which of course names them). */
  function sourceOutsideRegistry(): string {
    const parts: string[] = [];
    const stack = [SRC];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'cli-registry') stack.push(full);
          continue;
        }
        if (name.endsWith('.ts')) parts.push(uncommented(readFileSync(full, 'utf-8')));
      }
    }
    return parts.join('\n');
  }

  /**
   * Receivers whose same-named property is NOT this field. A leaf-name match is all a static
   * check can do, and `cli.ts` calls `palette.accent('admin')` — the terminal colour helper,
   * unrelated to `CliEntry.accent`. Listing the receiver is better than dropping the field
   * from the check: a real read through any OTHER receiver still fails.
   */
  const UNRELATED_RECEIVERS: Record<string, string[]> = { accent: ['palette'] };

  const outside = sourceOutsideRegistry();

  it.each(DECLARED_FOR_LATER)('%s is still unread outside the registry', (field) => {
    const leaf = field.split('.').pop()!;
    const ignore = UNRELATED_RECEIVERS[leaf] ?? [];
    // `.<leaf>` as a property access. Comment lines are already blanked, so a mention in
    // prose does not count as a read; a receiver listed above does not either.
    const pattern = new RegExp(`(\\w*)\\.${leaf}\\b`, 'g');
    const uses = [...outside.matchAll(pattern)].filter((m) => !ignore.includes(m[1])).map((m) => m[0]);
    expect(
      uses,
      `${field} now looks READ outside config/cli-registry. If that is deliberate, drop it ` +
        "from DECLARED_FOR_LATER here and from CliEntry's header comment — the point of both " +
        'is that a reader can tell which fields are load-bearing.'
    ).toEqual([]);
  });

  it('still catches a read when there is one (anti-vacuity)', () => {
    // The check is only worth having if it fires, so prove it against a field that IS read.
    // `capabilities.ralph` is live in session-routes; if this ever stops matching, the
    // scanner has drifted and every assertion above is passing vacuously.
    expect(outside).toMatch(/\.ralph\b/);
    expect(DECLARED_FOR_LATER.length).toBeGreaterThan(0);
  });
});
