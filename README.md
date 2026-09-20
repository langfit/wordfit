# Wordfit

Correct and naturalise what you write in the browser, using **your own running Claude Code
agent** as the model. No API key: the agent polls a local server, produces the correction,
and the extension shows it as a word-level diff you can accept.

Read `CONTEXT.md` for the vocabulary and `docs/adr/` for the two decisions that shape
everything else.

## How it fits together

```
select text / press Ctrl+Shift+Y
  → content script captures the Original + register context
  → service worker POSTs it to the local server, gets a Request id
  → server writes the text to a file and holds the Request (60s deadline)
  → wordfit-worker's `poll` tool returns the id and the file path
  → the worker reads it, writes the Rewrite to a file, calls `respond`
  → the extension short-polls the result and shows the diff
  → Accept splices it into the field
```

## Setup

```bash
npm install
npm run build
```

**1. Load the extension.** `chrome://extensions` → Developer mode → *Load unpacked* →
select the `extension/` directory.

**2. Enable the `adapt` MCP server** from `.mcp.json` (Cursor: `.cursor/mcp.json`) and
start a new session in this repo so `adapt` is connected from the first turn. A session
that began without it can start the server but cannot spawn a poller.

**3. Start the Loop.** In this repo:

```
/wordfit
```

Wait until it says the Loop is live and gives a port and token. The server alone is not
a Loop — *Save and test* will then report "no agent is polling".

**4. Configure the extension.** Click the extension icon, paste the port and token, set
your target language, press *Save and test*. It should say an agent is polling.

## Using it

Select text in any field (or just focus one) and press **Ctrl+Shift+Y**, or click the
**Fix** button that appears next to a selection. A popup shows the diff; Accept applies it.
On the result you can ask for a variant — *More formal*, *Simpler*, or a custom
instruction.

## What works, and what doesn't

Supported Targets: `<input>`, `<textarea>`, and plain `contenteditable` (Gmail, most chat
boxes).

Deliberately **not** supported: Slack, Notion, Linear, and anything else built on Quill,
ProseMirror, Lexical, CodeMirror or Monaco — a framework owns their content and direct DOM
writes get reverted. Google Docs renders to canvas and has no DOM text at all. The
extension detects these and offers the Rewrite to copy instead of corrupting the field.

## Things that will surprise you

- **A rewrite takes an agent turn**, ~10–30s, not an API round trip. That's inherent to
  having no API key (ADR-0001).
- **One at a time.** A second trigger while one is in flight is refused, because the agent
  is serialised anyway.
- **Close Claude Code and it stops working.** Requests then expire after 60s with a
  "no agent picked this up" message.
- **The worker restarts itself** every ~50 Requests to cap context growth. That's normal.

## Commands

| | |
|---|---|
| `npm run build` | compile server and extension |
| `npm test` | store behaviour: deadlines, serialisation, terminal states |
| `npm run typecheck` | both tsconfigs, no emit |
| `node dist/cli.js serve` | start the server by hand |
| `node dist/cli.js status` | is a Loop running |
| `node dist/cli.js poll` | take a Request as the agent would (debugging) |
| `node dist/cli.js stop` | drain and shut down |

`node dist/cli.js mcp` is the stdio MCP server declared in `.mcp.json` (and
`.cursor/mcp.json`); the agent host spawns it, you don't.

## Layout

```
src/            server, CLI, MCP server (no runtime dependencies)
extension/      MV3 extension; each entry point is self-contained
.claude/        the wordfit skill and the restricted wordfit-worker agent
docs/adr/       why it is built this way
```
