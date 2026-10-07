# COD-487 opt-in release and Brain canary

The feature is implemented in branch `feat/COD-487-openclaw-phases-0-1-3`.
Build/deployment, Bitbucket CI and real Telegram delivery are separate release
gates. This runbook does not authorize deployment or input to production Brain.

## Before production

1. Review the branch, focused regressions and isolated browser/native canary.
   Resolve new failures; record unrelated baseline failures separately.
2. Repeat SDK loader compatibility on the intended OpenClaw version and inspect
   Brain's exact local Codex native conversation, canonical workspace and CODEX_HOME
   read-only. Reject ambiguity or unsupported native events. No newest-file fallback.
3. Follow normal Codeman COM/Bitbucket release instructions when authorized.
   Verify the built/deployed version, localhost API, authenticated UI and pipeline.
   Keep source, build, CI and runtime observations separate in COD-487/COD-493.
4. First use a separate OpenClaw profile/bot and a throwaway assistant. Repeat
   duplicate delivery, gateway restart, queued cancellation and delivery recovery.
   The checked-in canary uses a test adapter; it is not proof of real bot delivery.

## Authorized Brain acceptance

1. Record Brain's session UUID, native conversation ID, binding generation,
   workspace and data-home. Confirm the composer is empty and the native turn has
   completed. Stop conflicting automation and direct tmux typing.
2. Create/bind Brain through Assistants, issue only read/submit/cancel access, and
   place its token in the gateway's service credential environment. Back up plugin
   configuration without copying secrets into Jira or source control.
3. Enable the plugin for the intended Telegram account and allowlist one numeric
   private-chat sender. Restart/reload the existing gateway through its normal
   management path; do not start a duplicate production poller.
4. Explicitly enable and hand off Brain. Send one tool-free marker prompt through
   `/brain`. Record trusted message ID, connector key, request UUID, native turn ID
   and result. Confirm the same session and conversation remained bound and the
   answer appeared only in the initiating private chat.
5. Inspect desktop/mobile request status, take control, and confirm terminal input
   is restored. Exercise queued cancellation with a separate test request only if
   authorized. Record actual native completion and Telegram receipt independently.
6. Update Jira with version, commit, pipeline, screenshots and the observed canary.
   Mark acceptance complete only after those gates pass.

## Attention and rollback

Disable the connector first to stop new ingress. Take control in Codeman to pause
requests and release the terminal; this does not interrupt the running CLI.
Review/stop any active task in the desktop, inspect possible side effects, and
explicitly reconcile uncertain records. Revoke its token and leave the assistant
disabled. Preserve `assistants.json`, `assistant-requests.json` and the gateway
outbox with their private permissions for audit/recovery.

Do not delete/recreate Brain, replay queued prompts, remove idempotency records,
or infer failure from a timeout. `delivery_unknown` needs notification review,
not another execution. After a service or session recovery, verify exact native
identity and explicitly rebind/handoff; never create a replacement conversation
implicitly. Rolling back code must retain new durable files; incompatible or
corrupt ledgers must fail closed rather than be reset.
