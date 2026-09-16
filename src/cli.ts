#!/usr/bin/env node
import { readRuntime } from "./runtime.js";
import { startServer } from "./server.js";
import { health, poll, respond, shutdown } from "./client.js";
import { runMcpServer } from "./mcp.js";
import { DEFAULT_POLL_TIMEOUT_S } from "./types.js";

const USAGE = `wordfit — correct and naturalise text using your own agent

  serve [--port N]              start the server and hold the Loop open
  status                        is a Loop running
  stop                          drain in-flight Requests and shut down
  poll [--timeout SECONDS]      block until a Request arrives (debugging; the
                                worker uses the MCP tools, not this)
  respond <id> --file <path>    post a Rewrite
  respond <id> --no-change      post "already fine"
  mcp                           run the stdio MCP server (spawned by Claude Code)
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "serve": {
      const portFlag = flag(rest, "--port");
      const existing = readRuntime();
      if (existing) {
        const alive = await health().then(
          () => true,
          () => false,
        );
        if (alive) {
          console.error(
            `A Loop is already running on port ${existing.port} (pid ${existing.pid}).`,
          );
          return 1;
        }
      }
      const { info, close } = await startServer(
        portFlag ? { port: Number(portFlag) } : {},
      );
      console.log(`listening on ${info.port}`);
      console.log(`token: ${info.token}`);
      const bye = () => void close().then(() => process.exit(0));
      process.on("SIGINT", bye);
      process.on("SIGTERM", bye);
      return -1; // stay alive
    }

    case "status": {
      const rt = readRuntime();
      if (!rt) {
        console.log("no Loop running");
        return 1;
      }
      try {
        const h = (await health()) as { inFlight: boolean; agents: number };
        console.log(
          `running on ${rt.port} (pid ${rt.pid}) — in flight: ${h.inFlight}, agents polling: ${h.agents}`,
        );
        return 0;
      } catch {
        console.log(`stale runtime file for port ${rt.port}; no server answering`);
        return 1;
      }
    }

    case "stop": {
      await shutdown();
      console.log("stopped");
      return 0;
    }

    case "poll": {
      const timeout = Number(flag(rest, "--timeout") ?? DEFAULT_POLL_TIMEOUT_S);
      const result = await poll(timeout);
      if ("status" in result) {
        console.log("status: idle");
        return 2; // Exit 2 means "nobody typed anything", not "something broke".
      }
      // Paths, not text: the CLI is for debugging and its output goes to a terminal.
      const { originalText: _t, contextText: _c, ...printable } = result;
      for (const [k, v] of Object.entries(printable)) {
        console.log(`${k}: ${v ?? "none"}`);
      }
      return 0;
    }

    case "respond": {
      const id = rest[0];
      if (!id) throw new Error("respond needs a Request id");
      const file = flag(rest, "--file");
      const noChange = rest.includes("--no-change");
      if (!file && !noChange) throw new Error("respond needs --file <path> or --no-change");
      const out = await respond(id, noChange ? { noChange: true } : { file: file! });
      console.log(out.accepted ? "accepted" : "too late — the Request had expired");
      return 0;
    }

    case "mcp": {
      await runMcpServer();
      return -1;
    }

    default:
      console.log(USAGE);
      return command === undefined || command === "--help" ? 0 : 1;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
