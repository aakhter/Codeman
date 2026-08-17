# COD-295 — trusted attachment-root configuration validation

**Lane:** review-gated (`security` label). Implemented on `cod-295-trusted-root-validation`, **not merged**.
**Date:** 2026-08-15 · **Base:** `local` @ `9ea95571` (v1.18.4, upstream drift 0)

## 1. What a trusted root actually grants

`CODEMAN_TRUSTED_ATTACHMENT_ROOTS` is the one place uploaded bytes may leave a session
workspace: an **admin** may make `<workspace>/.codeman-attachments` a **symlink**, and the
symlink's resolved target must exactly equal a listed root. Uploads then land *in* that root
and everything under it becomes servable by id.

That makes the root's **breadth** the whole security property. The runtime side was already
fail-closed (exact match, re-checked on every upload and delete, env-only so the browser
cannot add one) — but `parseTrustedAttachmentRoots()` accepted **any** existing canonical
directory that was not on the blocklist. `/` and `$HOME` both passed.

## 2. The two defects

**(a) No breadth check.** `CODEMAN_TRUSTED_ATTACHMENT_ROOTS=/` was accepted. So was `$HOME`,
`/home`, and any ancestor of `~/.codeman`, `~/codeman-cases` or `~/codeman-users`. An admin
who set one of those — by typo, by copying an example, or by reaching for "just make it
work" — silently converted an exact-root allowlist into the whole filesystem: uploads write
next to `state.json`, `users.json` and `hook-secret`, and everything under the root becomes
readable through the attachment id route.

This is a **misconfiguration-hardening** issue, not a remote-exploit one: it takes an admin
setting a bad value. That is exactly the class of thing a validator should catch, since the
value looks harmless and nothing reports it back.

**(b) Trailing separator silently disabled a root.** `realpath` strips a trailing separator,
so `/srv/enclave/` failed the `canonical !== candidate` comparison and was dropped with
`path must already be canonical` — a diagnostic that points at symlinks, not at the actual
cause. The operator's intended root simply did not exist, and the failure only shows up
later as an upload refusal.

## 3. The fix

`src/config/attachment-guard.ts`:

- **`isDedicatedAttachmentEnclave(canonicalRoot)`** — rejects a root that **is, or is an
  ancestor of**, any of `homedir()`, `getDataDir()`, `~/codeman-cases`, `getUserSpacesDir()`.
  Ancestor-or-equal is one predicate that covers `/`, `/home`, `$HOME` and each managed tree
  at once. Each managed tree is compared in **both** its raw and `realpath`'d form, because it
  may not exist yet (realpath throws) or may itself sit behind a symlink (`/tmp` on macOS).
  A directory *inside* a managed tree (`~/.codeman/shared-attachments`) stays valid — the
  rule is about breadth, not about location.
- **Trailing separators are normalized before the canonical comparison** (reusing the module's
  existing `normalizeTree`, which never reduces a bare separator to empty). Exact-root
  fail-closed semantics are unchanged: a symlinked alias still fails the comparison, now
  including when it is written with a trailing separator.
- Diagnostics stay **path-free** — they carry the entry's 1-based index and a reason, never
  the path, so a log cannot leak filesystem layout. A bad entry is still dropped rather than
  failing startup; with no valid roots the symlink form is simply unavailable.

Documentation (acceptance criterion 3): the env var is now in **CLAUDE.md's
"Security-relevant env vars"** line, in **`docs/security-architecture.md`** §11's quick
reference **and** a new §5 subsection covering the whole trust story, and in the module's
own `@fileoverview` as knob 3 alongside the blocklist and the confinement toggle.

## 4. Verification

Red-first, `test/trusted-attachment-roots.test.ts` (+6 cases, 12 → 18):

- **Before the fix: 3 failed / 15 passed.** `/` and `$HOME` were accepted; the managed-tree
  ancestors were accepted; `<root>/` was rejected.
- The other 3 new cases passed in the red run as designed — they are the **controls**
  (a dedicated dir inside a managed tree stays valid; a symlinked alias with a trailing
  separator is still refused; diagnostics stay path-free), and their job is to prove the fix
  does not over-reject or start leaking paths.
- **After the fix: 18/18.**

Neighbouring suites re-run unchanged: `attachment-upload-routes` 20/20 ·
`attachment-remove-routes` 18/18 · `trusted-upload-large-raw` 1/1 ·
`file-routes-attachment-path-guard` 19/19.

Gate (orchestrator-run, visible): `tsc --noEmit` 0 · `npm run lint` 0 · `prettier --check` on
the changed `src`/`test` files clean · `npm run test:ci` — counts in the Jira note.
`docs/security-architecture.md` is outside Prettier's configured scope (`format`/`format:check`
glob only `src/**/*.ts` and `src/web/public/**`) and already failed a manual prettier check
before this change; not touched.

## 5. Residual risk / not taken

- **A root inside `~/.codeman` is still accepted** (e.g. `~/.codeman/shared-attachments`).
  That is deliberate — it is a dedicated enclave — but it does sit in the same tree as
  `state.json` / `users.json` / `hook-secret`. The exact-root rule keeps uploads confined to
  the named subdirectory, so the neighbours are not reachable; tightening this further would
  reject a legitimate layout.
- **Startup-only parsing is unchanged.** A root deleted and recreated as a symlink after
  startup is caught by the per-operation re-check, not by this validator.
- **No runtime behaviour change for a valid existing configuration.** The only configurations
  that change meaning are ones that were dangerously broad (now refused) or written with a
  trailing separator (now honoured instead of silently dropped). Both are called out here
  because the second one **enables** a root that previously did nothing — an operator who
  worked around the bug by listing a path twice should re-read their configuration.
