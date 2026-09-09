import { requireRuntime } from "./runtime.js";
import { DEFAULT_POLL_TIMEOUT_S, type PolledRequest } from "./types.js";

async function call(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const rt = requireRuntime();
  const res = await fetch(`http://127.0.0.1:${rt.port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${rt.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // A poll legitimately hangs for minutes; never let fetch decide otherwise.
    signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? res.statusText;
    throw new Error(`${path} failed (${res.status}): ${msg}`);
  }
  return json;
}

export type PollResult = PolledRequest | { status: "idle" };

export async function poll(timeoutS = DEFAULT_POLL_TIMEOUT_S): Promise<PollResult> {
  return (await call(`/poll?timeout=${timeoutS}`, {
    timeoutMs: (timeoutS + 15) * 1000,
  })) as PollResult;
}

export async function respond(
  request: string,
  result: { rewrite: string } | { file: string } | { noChange: true },
): Promise<{ accepted: boolean }> {
  return (await call("/respond", {
    method: "POST",
    body: { request, ...result },
    timeoutMs: 30_000,
  })) as { accepted: boolean };
}

export async function health(): Promise<unknown> {
  return call("/health", { timeoutMs: 5_000 });
}

export async function shutdown(): Promise<void> {
  await call("/shutdown", { method: "POST", timeoutMs: 5_000 });
}
