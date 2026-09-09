# The agent is the model, not an API client

The server holds no API key and makes no model calls. Instead the user's own Claude Code
agent long-polls the local server for Requests, produces the Rewrite itself, and posts it
back — the pattern used by `lavish-axi`. We chose this because it runs entirely on the
user's existing Claude subscription with no key to provision, store, or leak.

## Consequences

These are not obvious from reading the code, and each one is load-bearing:

- **A Rewrite costs a full agent turn** (~10-30s), not an API round trip. The UX is built
  around a cancellable pending state, not around feeling instant. Do not "optimise" the
  wait away — it is inherent.
- **Requests are serialised.** One agent, one turn at a time, so exactly one Request may be
  in flight. A second trigger is refused rather than queued, because a queue the user
  cannot see is worse than a refusal.
- **No Loop means no product.** When no agent is polling, Requests can only expire (60s).
  The deadline exists to make that state legible instead of mysterious.
- **The agent's context grows with every Request served.** This is why the transport is
  file-based (ADR-0002) — it keeps the per-Request footprint to a path and a status line.
  A long-lived Loop will still eventually need restarting.
- **Web page text reaches an agent with local tool access.** The Loop therefore runs as a
  subagent whose tool surface makes an injection inert: it holds only `poll`, `respond`,
  `Read` and `Write`, with no shell, no network and no ability to edit this repo. This is
  why `poll` and `respond` are exposed as an MCP server and not only as a CLI — a worker
  that shelled out to the CLI would need `Bash`, which cannot be scoped to three commands
  and would leave the control resting on instructions the injected text is trying to
  override. Framing polled content as untrusted data is a second layer, not the control.

Revisiting this in favour of a hosted API key would remove every constraint above, which is
precisely why a future reader will be tempted. The trade is convenience and privacy against
latency and liveness, and we chose the former deliberately.
