# COD-523 external upload root implementation plan

Goal: let an explicitly mapped trusted workspace use its external attachment enclave without a workspace symlink.

Architecture: an environment-only JSON object maps exact canonical workspace paths to existing exact trusted roots. The guarded upload resolver checks this mapping before touching `.codeman-attachments`. Admin role, canonical existing directories and exact trusted-root membership remain mandatory. History and delete keep their logical relative paths; agent prompts receive an absolute canonical external path for trusted uploads.

- [x] Add failing resolver tests for mapping, missing symlink, non-admin, untrusted roots, workspace aliases, malformed config and existing upload preservation.
- [x] Add minimal guarded map resolution in `src/config/attachment-guard.ts`, forward configuration in `src/service-installer.ts`, and return canonical trusted agent paths in `src/web/routes/file-routes.ts`.
- [x] Verify resolver, upload, history and deletion suites; run typecheck, lint, formatting and lockfile checks.
- [x] Build isolated checkout and verify guarded resolver against actual workspace/external-root read-only without changing attachments.
- [x] Deploy only reviewed changes to canonical checkout; capture live session identities and tmux panes, set service mapping, build and restart web service while preserving mux; verify health and all existing sessions.
- [x] Remove compatibility link only after live mapped resolver verifies existing history reads. Verify new upload/read/delete in a throwaway session with a disposable fixture; preserve all original attachments. Capture OneDrive samples. Rollback: restore symlink and previous service environment/build if required.
