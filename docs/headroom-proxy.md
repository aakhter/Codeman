# Headroom (Context-Compression Proxy)

Headroom (COD-98 / COD-102) is an **optional upstream proxy that compresses
context** to extend the usable context window. It is wired into Codeman's session
spawn so sessions transparently route through it when healthy and fall back to the
direct API when not.

This doc covers the in-repo wiring. Proxy/deployment specifics (the NAS02
deployment, SSE-safe settings) live in the secret-bearing nas-docs project memory
(`headroom_proxy_nas02.md`), referenced from `CLAUDE.local.md` — not committed
here.

## Routing

`config/headroom-routing.ts` reads `headroomProxyUrl` / `headroomRouteClaude` /
`headroomRouteCodex` from `settings.json` **at call time**:

- **absent url** = baked-in default → feature **ON**
- **empty string `""`** = kill-switch → **OFF**

Routing is **health-gated** — a down proxy makes sessions fall back to the direct
API rather than failing.

## Injection per CLI

- **Claude sessions** → inject `ANTHROPIC_BASE_URL`.
- **Codex sessions** → manage the `~/.codex/config.toml` patch
  (`codex-headroom-patch.ts`).

## Status / stats

Status and stats surface via system routes plus a frontend **stats hero**
(savings %, cache, best %). Those counters are explicitly **proxy-wide** —
they include all proxy clients and historical proxy traffic, not just Codeman
sessions. When supplied by Headroom, the panel also renders the bounded
`agent_usage.agents` attribution and the `requests.by_provider` breakdown.

Each managed Claude/Codex row is instead a launch/respawn routing snapshot with
its recorded time. It does not attribute proxy requests to that session. A
settings update reconciles the shared Codex config immediately; an already
running session's snapshot changes only after it respawns.

## Key files

- `config/headroom-routing.ts` — call-time routing decision.
- `config/headroom-status.ts` — status/stats.
- `codex-headroom-patch.ts` — the Codex `config.toml` patch manager.

## Related

- `CLAUDE.md` → Architecture → Key Patterns → **Headroom**.
- `CLAUDE.local.md` → the nas-docs memory pointer for deployment specifics.
