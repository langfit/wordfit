import { loadConfig } from "./config.js";

/**
 * Network only. All timing lives in the content script, because an MV3 service worker
 * is killed after ~30s idle — far shorter than one agent turn (ADR-0001). Every poll
 * tick arrives here as a fresh message, which also wakes the worker back up.
 */

type Msg =
  | { type: "submit"; payload: Record<string, unknown> }
  | { type: "result"; request: string }
  | { type: "cancel"; request: string }
  | { type: "config" }
  | { type: "openOptions" };

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; body: any }> {
  const cfg = await loadConfig();
  if (!cfg.token) return { ok: false, status: 0, body: { error: "unconfigured" } };

  try {
    const res = await fetch(`${cfg.serverUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: { error: "unreachable" } };
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender: unknown, reply: (r: unknown) => void) => {
  void (async () => {
    switch (msg.type) {
      case "config":
        reply(await loadConfig());
        return;
      case "submit": {
        const cfg = await loadConfig();
        const r = await api("/request", {
          method: "POST",
          body: { ...msg.payload, targetLanguage: cfg.targetLanguage },
        });
        reply(r);
        return;
      }
      case "result":
        reply(await api(`/result/${encodeURIComponent(msg.request)}`));
        return;
      case "cancel":
        reply(await api(`/cancel/${encodeURIComponent(msg.request)}`, { method: "POST" }));
        return;
      case "openOptions":
        chrome.runtime.openOptionsPage();
        reply({ ok: true });
        return;
    }
  })();
  return true; // keep the message channel open for the async reply
});

chrome.commands.onCommand.addListener((command: string) => {
  if (command !== "wordfit") return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs: any[]) => {
    const id = tabs[0]?.id;
    if (id !== undefined) void chrome.tabs.sendMessage(id, { type: "trigger" }).catch(() => {});
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
