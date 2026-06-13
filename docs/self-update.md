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

## Related

- `CLAUDE.md` → Architecture → Key Patterns → **Self-update**, and the State Files
  note on `update-status.json`.
