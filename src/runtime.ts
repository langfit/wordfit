import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeInfo } from "./types.js";

/**
 * The MCP server is spawned by Claude Code, not by the skill, so it cannot be told
 * the port and token as arguments. Both processes rendezvous through this file.
 */
export const runtimeDir = () => join(process.cwd(), ".adapt");
const runtimeFile = () => join(runtimeDir(), "runtime.json");

export function writeRuntime(info: RuntimeInfo): void {
  mkdirSync(runtimeDir(), { recursive: true });
  // Token lives here. .adapt/ is gitignored.
  writeFileSync(runtimeFile(), JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readRuntime(): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(runtimeFile(), "utf8")) as RuntimeInfo;
  } catch {
    return null;
  }
}

export function clearRuntime(): void {
  try {
    rmSync(runtimeFile());
  } catch {
    /* already gone */
  }
}

export function requireRuntime(): RuntimeInfo {
  const rt = readRuntime();
  if (!rt) {
    throw new Error(
      "No Loop is running. Start one with `wordfit serve` (or the /wordfit skill).",
    );
  }
  return rt;
}
