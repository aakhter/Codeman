# Self-Update

The in-app updater (App Settings → Updates) updates **git-clone installs** that
are supervised by systemd/launchd. npm installs report as non-updatable. The hard
part — restarting the very process that's running the update — is handled by a
**detached** updater script that outlives the restart.

## Supervisor detection

| Supervisor | How it restarts |
|------------|-----------------|
| `systemd` | user unit |
| `launchd` | GUI LaunchAgent, gui-domain kickstart |
| `launchd-daemon` | KeepAlive system LaunchDaemon on headless Macs — restarts **rootlessly** by killing the server PID and letting launchd respawn it. Detected only when the daemon is bootstrapped AND KeepAlive |
| `none` | "restart manually" message; on next boot a manual-restart status auto-completes when the running version matches the target |

## Update flow

Because the update restarts the very process running it, the real work runs in a
DETACHED `scripts/self-update.sh`:

```
git checkout <release tag> && npm install && npm run build && restart
```

The script outlives the restart and writes progress to
`dataPath('update-status.json')`, which the browser **polls across the connection
drop** to follow the update through the restart.

- **Channel** = latest `codeman@X.Y.Z` release tag.
- **Dirty trees** are auto-stashed before checkout.

## Code layout

`src/web/self-update.ts` splits **PURE** helpers (semver/tag parsing, reconcile
decision — unit-tested) from **IO** wrappers (`getInstallInfo` / `checkForUpdate`
/ `startUpdate` / `reconcileUpdateOnBoot`).

- **Routes**: `GET /api/system/update/check`, `POST /api/system/update`,
  `GET /api/system/update/status`.
- **Types**: `src/types/update.ts`.

## Repository status (fork-aware)

Distinct from the release-tag updater above: an **informational** view (App
Settings → Updates → "Check repository status") of how the local checkout sits
relative to one or more remotes — the upstream project **and** the maintainer's
own fork — by commit **ahead/behind** count plus a short list of the **incoming**
commits per remote. No tags required, no checkout/merge performed.

- **Backend**: `src/web/repo-status.ts` (PURE parsing/decision helpers, unit
  tested in `test/repo-status.test.ts`, split from the `getRepositoryStatus()` IO
  wrapper). Per remote it does a READ-ONLY `git fetch --no-tags <remote> -- <branch>`
  (updates only remote-tracking refs under `.git`, never the working tree), then
  `git rev-list --left-right --count` + `git log --oneline`. Non-interactive
  (`GIT_TERMINAL_PROMPT=0`, SSH `BatchMode=yes`); an unreachable remote surfaces
  as that card's `error` and never fails the whole call.
- **Remote selection (generalizable)**: by default the union of `origin` and the
  current branch's `@{upstream}` tracking remote, deduped (tracking remote labeled
  "Your remote", `origin`/`upstream` labeled "Upstream"). Override with
  **`CODEMAN_UPDATE_REMOTES`** (comma-separated remote names) for any other layout,
  e.g. the common `origin`=fork / `upstream`=canonical convention.
- **Security**: remote names and branch names reach git as positionals; values
  derived from untrusted `ls-remote --symref` output or a stray
  `CODEMAN_UPDATE_REMOTES` entry are rejected if they could act as a flag
  (`isSafeGitPositional`, plus a `--` argument separator on the fetch).
- **Route**: `GET /api/system/repo-status`.

## Related

- `CLAUDE.md` → Architecture → Key Patterns → **Self-update**, and the State Files
  note on `update-status.json`.
