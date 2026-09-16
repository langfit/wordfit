# Requests and Rewrites cross the agent boundary as text, not shell arguments

User text never appears as a shell argument. The CLI (`wordfit poll` / `wordfit respond
--file`) passes it as files; the MCP tools the worker actually uses pass it inline as JSON
tool arguments. Both avoid the shell entirely, which was the point.

## Considered Options

- **Command-line arguments** (`wordfit respond <id> "text"`): rejected. Originals contain
  newlines, quotes, backticks and `$`. Shell quoting of arbitrary user text is a bug class,
  not a detail, and a backtick is command substitution.
- **JSON on stdin/stdout**: rejected. It requires the model to emit correctly escaped JSON
  containing arbitrary text, which models do unreliably. A malformed escape means a failed
  Request for reasons the user cannot diagnose.
- **Plain-text files both directions**: chosen.

## Consequences

- Structured information rides as CLI flags (e.g. `--no-change`), never as text the model
  has to format. The model's entire output contract is "write the Rewrite to this file".
- The per-Request context cost to the agent is a path and a status line rather than the
  full text twice over. This is what makes a long-running Loop viable at all (ADR-0001).

This looks like over-engineering until you know both reasons, which is why it is written
down.

## Amendment: the worker passes text inline, not as file paths

Originally *both* transports used files, and the worker read and wrote them with `Read` and
`Write`. That was wrong, and the symptom was every Request expiring:

```
 0.0s  submit -> 201
 1.1s  serving      <- worker took it instantly
60.3s  expired      <- never answered
```

Files cost two extra model round trips per Request — `poll`, `Read`, `Write`, `respond` —
which does not fit in a deadline sized for "one agent turn". The two decisions were set in
different rounds and were never checked against each other.

The rationale above is specifically about **shell arguments**, and the worker has no shell:
it calls MCP tools, whose arguments are JSON. Escaping a string into JSON is the transport's
job and it does not fail the way `argv` quoting does, so the file indirection was protecting
against nothing while costing the latency budget. The context-economy argument for paths was
real but much smaller than assumed — an Original is a text field's worth of tokens, not a
document.

So: the MCP tools carry `originalText` and `rewrite` inline, two round trips per Request.
The CLI keeps files, because a CLI *does* have a shell. The deadline moved 60s -> 120s at
the same time, since even two round trips over a long Original can pass a minute.

This also tightened ADR-0001's boundary rather than loosening it: with no files to read or
write, the worker dropped `Read` and `Write` and now holds two tools and no filesystem.
