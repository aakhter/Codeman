# COD-441 remote frame SSH connection reuse

## Production baseline and scope

On 2026-09-24, eight live Codeman remote sessions used worker `192.168.20.91`.
Read-only `GET /api/sessions/:id/terminal?frame=1` samples for an idle remote
session took 435–732 ms across nine requests; local frame controls took 49–76 ms.
The earlier production journal also recorded a remote frame capture killed at its
10-second timeout. These measurements motivated reusing SSH connections for
visible frames. Full-history capture and remote agent launch remain outside this
change.

## Implementation probe

A disposable process set `CODEMAN_DATA_DIR` to a temporary directory, created a
`TmuxManager`, and called `captureRemotePaneBuffer` three times for the same
owned remote session with `{ visibleFrame: true, owner: 'cod441-probe' }`. It
printed only elapsed time, byte count, and a shortened SHA-256 digest; the
captured terminal content was never logged. The process then called
`closeRemoteFrameConnections()` and removed its temporary data directory.

| Capture | Elapsed | Formatted frame | Digest prefix |
| ------- | ------: | --------------: | ------------- |
| Cold    |  871 ms |     3,934 bytes | `da4a9438fc82` |
| Warm 1  |   55 ms |     3,934 bytes | `da4a9438fc82` |
| Warm 2  |   69 ms |     3,934 bytes | `da4a9438fc82` |

An independent disposable OpenSSH control-socket probe on the same worker took
406 ms cold and 24–75 ms warm across three reused captures, with identical raw
output. It sent `ssh -O exit` and removed its private socket directory.

The after measurements are isolated capture probes, not a deployed production
browser measurement. Production acceptance still needs a separate release and
live browser check. The focused route, frame, full-history, and pool tests passed
221/221; typecheck, lint (one unchanged warning), format, lockfile, and build
completed successfully.
