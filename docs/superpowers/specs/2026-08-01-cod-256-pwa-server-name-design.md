# COD-256: Persist the server name in Android PWA installs

## Problem

Codeman already renders each normal browser window title as `<display-name>:<server-host>`, but the PWA manifest is a
static file whose `name` and `short_name` are always `Codeman`. Android therefore installs every server with the same
generic label and discards the server identity that was visible in the browser tab.

## Decision

Serve the manifest through Codeman instead of relying on the static JSON file. The server will derive the manifest
identity from the same server-authoritative title used by the HTML shell, while retaining the existing icons, display
mode, colors, start URL, and scope. The HTML keeps a same-origin manifest link, so every browser and installed PWA gets
the identity of the server it actually connected to.

The response will be valid `application/manifest+json` and explicitly revalidated rather than cached as an immutable
static asset. User-configured display names remain supported, and hostile-looking display names or hostnames are safe
because JSON serialization provides the manifest escaping boundary.

## Alternatives considered

- Generate a blob manifest in browser JavaScript. Rejected because install-prompt timing and blob-manifest support are
  less consistent on Android and it makes local browser state authoritative.
- Store a PWA-only name in localStorage. Rejected because installed application labels come from the manifest and the
  value would not survive a different browser client.
- Add a separate server-name setting. Rejected as unnecessary: Codeman already has a canonical title hostname and a
  persisted display name.

## Compatibility and lifecycle

The default manifest label is `codeman:<server-host>`. A configured branding name produces
`<display-name>:<server-host>`, matching the browser title. Existing installs may require Android to refresh the
manifest metadata or be reinstalled; new installs receive the correct label immediately. Rebuilds and Codeman upgrades
cannot erase the identity because it is recomputed from server configuration on each manifest request.

## Verification

- RED then GREEN route/unit coverage for default, custom, and hostile-looking server identities.
- Regression coverage that the manifest retains the existing PWA fields and is not served with immutable caching.
- Focused title/branding tests, typecheck, lint, formatting, lockfile, frontend/public-asset checks, and build.
- Isolated beta request plus an Android/PWA browser check that reads the served manifest and confirms the server-specific
  name without touching production.

## Boundaries

No production deployment, package rename, storage-key rename, CLI/API rename, service-worker behavior change, or client
localStorage migration is part of COD-256.
