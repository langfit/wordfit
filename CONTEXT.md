# AI Lang Adapt

A Chrome extension that corrects and naturalises text written by a non-native speaker,
using the user's own running Claude Code agent as the model rather than a hosted API.

## Language

### The text

**Original**:
The text taken from the Target when the user triggers a correction. Either the current
selection or, when there is none, the Target's full contents.
_Avoid_: input, source text, draft

**Rewrite**:
The corrected, naturalised text the agent produces for an Original. Always plain text and
nothing else — no markup, no diff, no commentary.
_Avoid_: suggestion, correction, output, completion

**Diff**:
The word-level comparison between an Original and its Rewrite, computed in the extension.
It is never produced by the agent.
_Avoid_: changes, edits, patch

**Target Language**:
The language a Rewrite is written in, chosen by the user. Fixed per user, independent of
the language the Original happens to be in.

### The exchange

**Request**:
One Original together with its Context, waiting to be answered with a Rewrite. A Request
expires if no Rewrite arrives before its deadline.
_Avoid_: job, task, message, prompt

**Context**:
The register signals sent alongside an Original — page origin, page title, and the Target's
label or placeholder. Never page body content.
_Avoid_: metadata, page data

**Loop**:
The period during which an agent is polling for Requests and can serve them. Outside a Loop
there is no model, and Requests can only expire.
_Avoid_: session, daemon, worker, connection

### The page

**Target**:
The editable element a correction applies to. Deliberately not "field", because a
`contenteditable` element is not one.
_Avoid_: field, input, editor

**Supported Target**:
A Target the extension can write a Rewrite back into safely. Anything else is an
Unsupported Target, which is offered the Rewrite to copy rather than having it applied.

**Suggestion Popup**:
The UI anchored to a Target that shows a Rewrite as a Diff and offers to apply it.
_Avoid_: suggestion card, tooltip, overlay
