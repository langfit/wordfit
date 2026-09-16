import { createInterface } from "node:readline";
import { poll, respond } from "./client.js";
import { DEFAULT_POLL_TIMEOUT_S } from "./types.js";

/**
 * A minimal MCP stdio server exposing exactly two tools.
 *
 * This exists so the worker agent can serve Requests without `Bash` (ADR-0001). A
 * worker that shelled out to the CLI would need a shell, and a shell cannot be scoped
 * to three commands — which would leave the security boundary resting on instructions
 * that the injected text is actively trying to override.
 *
 * Text crosses inline here rather than as a file path. Tool arguments are JSON, so the
 * quoting hazard that made files the right answer for the CLI does not exist, and the
 * two saved model round trips are the difference between answering inside the deadline
 * and missing it. See ADR-0002's amendment.
 */

const TOOLS = [
  {
    name: "poll",
    description:
      "Block until a Rewrite Request arrives, then return it with the text to rewrite. " +
      "Returns { status: 'idle' } if nothing arrived before the deadline; poll again.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "respond",
    description:
      "Post the Rewrite for a Request. Give `rewrite` (the corrected text) or " +
      "`noChange: true` when the Original was already correct and natural.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "The Request id from poll." },
        rewrite: { type: "string", description: "The corrected text, and nothing else." },
        noChange: { type: "boolean" },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
] as const;

type Json = Record<string, unknown>;

function write(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: unknown, result: Json): void {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id: unknown, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(payload: unknown, isError = false): Json {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

async function callTool(name: string, args: Json): Promise<Json> {
  try {
    if (name === "poll") {
      const result = await poll(DEFAULT_POLL_TIMEOUT_S);
      if ("status" in result) return textResult(result);
      // The worker has no filesystem, so the paths would only be noise to it.
      const { original: _o, context: _c, ...forAgent } = result;
      return textResult(forAgent);
    }
    if (name === "respond") {
      const request = typeof args.request === "string" ? args.request : "";
      if (!request) return textResult({ error: "`request` is required" }, true);
      if (args.noChange === true) {
        return textResult(await respond(request, { noChange: true }));
      }
      if (typeof args.rewrite !== "string") {
        return textResult({ error: "give `rewrite` (a string) or `noChange: true`" }, true);
      }
      return textResult(await respond(request, { rewrite: args.rewrite }));
    }
    return textResult({ error: `Unknown tool: ${name}` }, true);
  } catch (err) {
    // Surfaced to the worker as a tool error; three in a row means the server is gone.
    return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

export async function runMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (line.trim() === "") continue;

    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      continue; // Not our problem; the client owns framing.
    }

    const { id, method, params } = msg as {
      id?: unknown;
      method?: string;
      params?: Json;
    };

    // Notifications carry no id and expect no reply.
    if (id === undefined) continue;

    switch (method) {
      case "initialize": {
        const requested = (params?.protocolVersion as string | undefined) ?? "2024-11-05";
        ok(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "wordfit", version: "0.1.0" },
        });
        break;
      }
      case "ping":
        ok(id, {});
        break;
      case "tools/list":
        ok(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = (params?.arguments as Json | undefined) ?? {};
        ok(id, await callTool(name, args));
        break;
      }
      default:
        fail(id, -32601, `Method not found: ${String(method)}`);
    }
  }
}
