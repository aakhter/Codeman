# COD-415 Codex Background Helper Status Design

## Goal

Do not show a ready Codex session as working solely because it retains a durable background helper, such as a mockup HTTP server.

## Decision

When Codex renders its composer and reports one or more background terminals, Codeman will treat the session as input-ready. The interface may continue to surface the background-terminal fact separately, but it must not make the session unavailable or label it Working.

The existing higher-priority evidence remains unchanged: an actual Codex Working frame and an explicit user-choice prompt continue to prevent an idle transition. A background-terminal-only frame is therefore no longer proof of an active Codex turn.

## Scope

The change is limited to the rendered-frame classification used by the external-CLI quiet-window timer. It does not terminate, inspect, classify by command name, or otherwise manage background processes. This avoids guessing whether a server, watcher, test, or build is important work: the status is about the parent agent's availability.

## Verification

Focused unit tests will prove that a ready composer with a background-terminal count becomes input-ready, while real Working frames and action-required dialogs retain their current precedence. The existing Codex working-detection tests will be run alongside the changed regression test.
