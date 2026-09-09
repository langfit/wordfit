import { DEFAULTS, loadConfig, type Config } from "./config.js";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = () => document.getElementById("status") as HTMLDivElement;

void loadConfig().then((cfg) => {
  $("serverUrl").value = cfg.serverUrl;
  $("token").value = cfg.token;
  $("targetLanguage").value = cfg.targetLanguage;
});

document.getElementById("save")?.addEventListener("click", () => {
  void (async () => {
    const cfg: Config = {
      serverUrl: $("serverUrl").value.trim().replace(/\/$/, "") || DEFAULTS.serverUrl,
      token: $("token").value.trim(),
      targetLanguage: $("targetLanguage").value.trim() || DEFAULTS.targetLanguage,
    };
    await chrome.storage.sync.set(cfg);

    const el = status();
    el.textContent = "Testing…";
    el.className = "";
    try {
      const res = await fetch(`${cfg.serverUrl}/health`);
      const body = (await res.json()) as { agents?: number };
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      el.className = "ok";
      el.textContent =
        (body.agents ?? 0) > 0
          ? "Saved. Server is up and an agent is polling — you're ready."
          : "Saved. Server is up, but no agent is polling: run /adapt-loop in Claude Code.";
    } catch (err) {
      el.className = "bad";
      el.textContent = `Saved, but could not reach the server: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  })();
});
