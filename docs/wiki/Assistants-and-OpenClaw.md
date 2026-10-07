# Assistants and OpenClaw

Use a named assistant to send Telegram requests into the same local Codex
conversation you use in Codeman. OpenClaw handles messaging; Codeman owns the
conversation binding, request queue and final results.

Open **Assistants**, create Brain, and choose its existing local Codex session.
Bind validates its exact native conversation. Clear the terminal composer, finish
any task, stop direct tmux typing and disable session automation. Enable Brain,
check the handoff confirmation and hand control to messaging.

Create a read/submit/cancel connector token and copy its one-time value into the
OpenClaw gateway's credential environment. Install the separate connector and
allowlist your private Telegram sender/account using the
[connector setup](../../integrations/openclaw/README.md) instructions.

Send `/brain <single-line request>`. The acknowledgement includes a connector key
for `/brain status <key>`, `/brain result <key>` and `/brain cancel <key>`.
Only queued work can be cancelled. Completed answers go to the initiating
private chat; ordinary desktop conversation output is not broadcast.

While handed off, the desktop terminal remains visible and its input is locked.
Use **Take control** to pause requests and restore typing. This does not stop the
CLI: finish/stop the task and handle approvals in the terminal. Review possible
side effects and confirm reconciliation for uncertain or interrupted requests
before enabling again. After recovery, explicitly verify and rebind the native
conversation, then hand off again.

A timeout or unknown delivery never means execution can safely be repeated.
Codeman preserves results/idempotency keys and the connector preserves delivery
state. Retrieve the original result and review an uncertain notification before
manually sending it again. Revoke connector tokens and keep Brain disabled when
messaging is no longer needed.
