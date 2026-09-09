/** Shared shapes. See CONTEXT.md for what these words mean. */

/** What the extension sends when the user triggers a correction. */
export interface RequestInput {
  original: string;
  /** Surrounding Target text when only a selection is being rewritten. */
  context: string | null;
  targetLanguage: string;
  origin: string;
  title: string;
  label: string | null;
  /** Set only by a variant re-run from the Suggestion Popup ("more formal", ...). */
  instruction: string | null;
}

export type RequestState =
  | { status: "pending" }
  | { status: "serving" }
  | { status: "done"; rewrite: string }
  | { status: "nochange" }
  /** Nobody ever polled for it. */
  | { status: "expired" }
  /** An agent took it and did not answer in time. */
  | { status: "timeout" }
  | { status: "cancelled" };

export interface AdaptRequest {
  id: string;
  input: RequestInput;
  /** Where the Original and Context were written. ADR-0002: files, not arguments. */
  originalPath: string;
  contextPath: string | null;
  createdAt: number;
  expiresAt: number;
  state: RequestState;
}

/** What `poll` hands the agent. Deliberately paths, not text. */
export interface PolledRequest {
  request: string;
  /** The text itself. The MCP worker has no filesystem; it reads this directly. */
  originalText: string;
  contextText: string | null;
  /** Paths to the same content, for the CLI and for debugging. */
  original: string;
  context: string | null;
  targetLanguage: string;
  origin: string;
  title: string;
  label: string | null;
  instruction: string | null;
}

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

/**
 * Q8: a Request that is never answered dies here rather than arriving late.
 *
 * 60s was the original figure, chosen for "one agent turn". It was too tight even
 * after cutting the worker to two round trips: a cold subagent plus two model turns
 * over a long Original can pass a minute. See ADR-0002's amendment.
 */
export const REQUEST_TTL_MS = 120_000;
export const DEFAULT_PORT = 47821;
/** Long enough that idle polls stay cheap in agent turns. See the skill. */
export const DEFAULT_POLL_TIMEOUT_S = 300;
/** Cursor (and similar hosts) abort MCP tool calls around 60s. Idle must return sooner. */
export const MAX_POLL_TIMEOUT_S = 25;
