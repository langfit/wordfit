import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BusyError, RequestStore, readRewriteFile, toPolled } from "./store.js";
import { clearRuntime, writeRuntime } from "./runtime.js";
import {
  DEFAULT_POLL_TIMEOUT_S,
  DEFAULT_PORT,
  MAX_POLL_TIMEOUT_S,
  type RequestInput,
  type RuntimeInfo,
} from "./types.js";

const MAX_BODY = 1_000_000; // 1MB of text is already far past what a Target holds.

/**
 * Q20: only the extension may spend the user's agent turns. Any Origin at all means
 * the caller is a web page context, and the only one allowed is our own extension.
 */
function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin.startsWith("chrome-extension://");
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  // Chrome's Private Network Access preflight for public page -> loopback.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseInput(body: unknown): RequestInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const original = str(b.original);
  if (original.length === 0) throw new Error("`original` is required");
  return {
    original,
    context: nullableStr(b.context),
    targetLanguage: str(b.targetLanguage, "English"),
    origin: str(b.origin, "unknown"),
    title: str(b.title, ""),
    label: nullableStr(b.label),
    instruction: nullableStr(b.instruction),
  };
}

export interface StartedServer {
  info: RuntimeInfo;
  close: () => Promise<void>;
}

export async function startServer(opts: { port?: number } = {}): Promise<StartedServer> {
  const store = new RequestStore();
  const token = randomBytes(24).toString("base64url");
  const port = opts.port ?? Number(process.env.ADAPT_PORT ?? DEFAULT_PORT);

  let closing = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(req, res);

    if (!originAllowed(req.headers.origin)) {
      send(res, 403, { error: "Origin not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      send(res, 200, { ok: true, inFlight: store.inFlight, agents: store.waiting });
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      send(res, 401, { error: "Bad or missing token" });
      return;
    }

    // ---- extension side ----

    if (path === "/request" && req.method === "POST") {
      try {
        const created = store.submit(parseInput(await readBody(req)));
        send(res, 201, { request: created.id, expiresAt: created.expiresAt });
      } catch (err) {
        if (err instanceof BusyError) {
          // Q9: refused, not queued. A queue the user cannot see is worse.
          send(res, 409, { error: "busy" });
          return;
        }
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (path.startsWith("/result/") && req.method === "GET") {
      const state = store.stateOf(decodeURIComponent(path.slice("/result/".length)));
      send(res, 200, state ?? { status: "expired" });
      return;
    }

    if (path.startsWith("/cancel/") && req.method === "POST") {
      const ok = store.cancel(decodeURIComponent(path.slice("/cancel/".length)));
      send(res, 200, { cancelled: ok });
      return;
    }

    // ---- agent side ----

    if (path === "/poll" && req.method === "GET") {
      const seconds = Number(url.searchParams.get("timeout") ?? DEFAULT_POLL_TIMEOUT_S);
      const polled = await store.poll(
        Math.max(1, Math.min(seconds, MAX_POLL_TIMEOUT_S)) * 1000,
      );
      send(res, 200, polled ? toPolled(polled) : { status: "idle" });
      return;
    }

    if (path === "/respond" && req.method === "POST") {
      const b = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      const id = str(b.request);
      let accepted: boolean;
      if (b.noChange === true) {
        accepted = store.respond(id, { noChange: true });
      } else {
        const rewrite =
          typeof b.file === "string" ? readRewriteFile(b.file) : str(b.rewrite);
        accepted = store.respond(id, { rewrite });
      }
      // `accepted: false` means the deadline passed while the agent was thinking.
      send(res, 200, { accepted });
      return;
    }

    if (path === "/shutdown" && req.method === "POST") {
      send(res, 200, { stopping: true });
      closing = true;
      store.drain();
      setTimeout(() => void close(), 50).unref?.();
      return;
    }

    send(res, 404, { error: `No route for ${req.method} ${path}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const info: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeRuntime(info);

  async function close(): Promise<void> {
    if (!closing) store.drain();
    clearRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { info, close };
}
