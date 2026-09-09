import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeDir } from "./runtime.js";
import {
  REQUEST_TTL_MS,
  type AdaptRequest,
  type PolledRequest,
  type RequestInput,
  type RequestState,
} from "./types.js";

type Waiter = (r: AdaptRequest | null) => void;

export class BusyError extends Error {
  constructor() {
    super("A Request is already in flight.");
  }
}

/**
 * Holds at most one live Request.
 *
 * Requests are serialised because the model is a single agent taking one turn at a
 * time (ADR-0001). A queue here would only hide that from the user.
 */
export class RequestStore {
  private current: AdaptRequest | null = null;
  private waiters: Waiter[] = [];
  /** Finished Requests, kept briefly so the extension's next poll can read the result. */
  private finished = new Map<string, AdaptRequest>();

  submit(input: RequestInput): AdaptRequest {
    this.sweep();
    if (this.current) throw new BusyError();

    const id = randomUUID();
    const dir = join(runtimeDir(), "requests", id);
    mkdirSync(dir, { recursive: true });

    // ADR-0002: the text crosses the agent boundary as files, never as arguments.
    const originalPath = join(dir, "original.txt");
    writeFileSync(originalPath, input.original, "utf8");

    let contextPath: string | null = null;
    if (input.context !== null && input.context !== "") {
      contextPath = join(dir, "context.txt");
      writeFileSync(contextPath, input.context, "utf8");
    }

    const now = Date.now();
    const req: AdaptRequest = {
      id,
      input,
      originalPath,
      contextPath,
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      state: { status: "pending" },
    };
    this.current = req;

    const waiter = this.waiters.shift();
    if (waiter) {
      req.state = { status: "serving" };
      waiter(req);
    }
    return req;
  }

  /** Resolves with a Request, or null when the deadline passes with nothing to serve. */
  poll(timeoutMs: number): Promise<AdaptRequest | null> {
    this.sweep();
    if (this.current && this.current.state.status === "pending") {
      this.current.state = { status: "serving" };
      return Promise.resolve(this.current);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      // Do not keep the process alive purely to wait.
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * Accepts a Rewrite. Returns false when the Request is already gone — the deadline
   * passed while the agent was thinking. That is expected, not an error: the worker
   * should shrug and go back to polling.
   */
  respond(id: string, result: { rewrite: string } | { noChange: true }): boolean {
    this.sweep();
    const req = this.current;
    if (!req || req.id !== id) return false;

    req.state =
      "noChange" in result
        ? { status: "nochange" }
        : { status: "done", rewrite: result.rewrite };
    this.retire(req);
    return true;
  }

  cancel(id: string): boolean {
    const req = this.current;
    if (!req || req.id !== id) return false;
    req.state = { status: "cancelled" };
    this.retire(req);
    return true;
  }

  stateOf(id: string): RequestState | null {
    this.sweep();
    if (this.current?.id === id) return this.current.state;
    return this.finished.get(id)?.state ?? null;
  }

  get inFlight(): boolean {
    this.sweep();
    return this.current !== null;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Fails every waiter so `poll` returns promptly on shutdown. */
  drain(): void {
    for (const w of this.waiters.splice(0)) w(null);
    if (this.current) {
      this.current.state = { status: "cancelled" };
      this.retire(this.current);
    }
  }

  private retire(req: AdaptRequest): void {
    this.current = null;
    this.finished.set(req.id, req);
    // The extension short-polls every second; a minute is generous.
    const t = setTimeout(() => this.finished.delete(req.id), 60_000);
    t.unref?.();
  }

  private sweep(): void {
    const req = this.current;
    if (req && Date.now() > req.expiresAt) {
      // Distinguish "nobody was listening" from "the agent was too slow". The user
      // can act on the first and can only wait out the second.
      req.state =
        req.state.status === "serving" ? { status: "timeout" } : { status: "expired" };
      this.retire(req);
    }
  }
}

export function toPolled(req: AdaptRequest): PolledRequest {
  return {
    request: req.id,
    originalText: req.input.original,
    contextText: req.input.context,
    original: req.originalPath,
    context: req.contextPath,
    targetLanguage: req.input.targetLanguage,
    origin: req.input.origin,
    title: req.input.title,
    label: req.input.label,
    instruction: req.input.instruction,
  };
}

export function readRewriteFile(path: string): string {
  return readFileSync(path, "utf8");
}
