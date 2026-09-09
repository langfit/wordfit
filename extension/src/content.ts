/**
 * Content script. Deliberately self-contained: MV3 content scripts cannot be ES
 * modules, so this file imports nothing and declares nothing globally.
 */
(() => {
  // ---------------------------------------------------------------- targets

  /**
   * Editors that ignore direct DOM writes because a framework owns their content
   * (ADR: out of scope). We detect them to refuse honestly rather than corrupt them.
   */
  const UNSUPPORTED = [
    ".ql-editor", // Quill — Slack
    ".ProseMirror", // ProseMirror — Notion-likes, Linear
    "[data-lexical-editor]", // Lexical — Meta apps
    ".notion-page-content",
    ".CodeMirror",
    ".cm-editor",
    ".monaco-editor",
    ".kix-appview", // Google Docs — canvas, no DOM text at all
    "[contenteditable][role='textbox'][data-slate-editor]",
  ].join(",");

  const TEXTUAL_INPUT = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "",
  ]);

  type Tier = "input" | "contenteditable" | "unsupported";

  function classify(el: Element | null): { el: HTMLElement; tier: Tier } | null {
    if (!(el instanceof HTMLElement)) return null;

    if (el instanceof HTMLTextAreaElement) return { el, tier: "input" };
    if (el instanceof HTMLInputElement && TEXTUAL_INPUT.has(el.type)) {
      return { el, tier: "input" };
    }

    const editable = el.closest<HTMLElement>("[contenteditable='true'],[contenteditable='']");
    if (editable) {
      return { el: editable, tier: editable.closest(UNSUPPORTED) ? "unsupported" : "contenteditable" };
    }
    return null;
  }

  function labelFor(el: HTMLElement): string | null {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = document.getElementById(labelledBy)?.textContent?.trim();
      if (t) return t.slice(0, 120);
    }
    const ph = el.getAttribute("placeholder") ?? el.getAttribute("data-placeholder");
    if (ph) return ph;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const lbl = el.labels?.[0]?.textContent?.trim();
      if (lbl) return lbl.slice(0, 120);
    }
    return null;
  }

  // ------------------------------------------------------------ what to send

  interface Capture {
    el: HTMLElement;
    tier: Tier;
    original: string;
    /** The rest of the field, when only a selection is being rewritten. */
    context: string | null;
    /** How to put the Rewrite back. */
    apply: (rewrite: string) => boolean;
    rect: () => DOMRect;
  }

  function captureInput(el: HTMLInputElement | HTMLTextAreaElement): Capture | null {
    const value = el.value;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    const hasSelection = e > s;
    const original = hasSelection ? value.slice(s, e) : value;
    if (original.trim() === "") return null;

    return {
      el,
      tier: "input",
      original,
      context: hasSelection ? value : null,
      rect: () => el.getBoundingClientRect(),
      apply: (rewrite) => {
        el.focus();
        if (hasSelection) {
          el.setRangeText(rewrite, s, e, "end");
        } else {
          el.setRangeText(rewrite, 0, value.length, "end");
        }
        // React and friends listen for this; without it the value snaps back.
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
    };
  }

  function captureEditable(el: HTMLElement, tier: Tier): Capture | null {
    const sel = window.getSelection();
    const inside =
      sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer);
    const hasSelection = Boolean(inside && sel && !sel.isCollapsed);

    const range = hasSelection && sel ? sel.getRangeAt(0).cloneRange() : null;
    const whole = el.innerText;
    const original = hasSelection && range ? range.toString() : whole;
    if (original.trim() === "") return null;

    return {
      el,
      tier,
      original,
      context: hasSelection ? whole : null,
      rect: () => (range ? range.getBoundingClientRect() : el.getBoundingClientRect()),
      apply: (rewrite) => {
        if (tier === "unsupported") return false;
        el.focus();
        const s = window.getSelection();
        if (!s) return false;
        s.removeAllRanges();
        if (range) {
          s.addRange(range);
        } else {
          const r = document.createRange();
          r.selectNodeContents(el);
          s.addRange(r);
        }
        // Deprecated, and still the only way to replace text without destroying
        // the page's undo stack. document.execCommand stays until that changes.
        return document.execCommand("insertText", false, rewrite);
      },
    };
  }

  function capture(): Capture | null {
    const found = classify(document.activeElement);
    if (!found) return null;
    if (found.el instanceof HTMLInputElement || found.el instanceof HTMLTextAreaElement) {
      return captureInput(found.el);
    }
    return captureEditable(found.el, found.tier);
  }

  // ------------------------------------------------------------------- diff

  type Piece = { t: "eq" | "del" | "ins"; v: string };

  const tokenize = (s: string): string[] => s.match(/\s+|\S+/g) ?? [];

  /** Word-level LCS. Q13: the Diff is computed here, never asked of the model. */
  function wordDiff(before: string, after: string): Piece[] | null {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length * b.length > 1_500_000) return null; // too big to be worth showing

    const w = b.length + 1;
    const dp = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          a[i] === b[j]
            ? dp[(i + 1) * w + j + 1]! + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }

    const out: Piece[] = [];
    const push = (t: Piece["t"], v: string) => {
      const last = out[out.length - 1];
      if (last && last.t === t) last.v += v;
      else out.push({ t, v });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        push("eq", a[i]!);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        push("del", a[i]!);
        i++;
      } else {
        push("ins", b[j]!);
        j++;
      }
    }
    while (i < a.length) push("del", a[i++]!);
    while (j < b.length) push("ins", b[j++]!);
    return out;
  }

  // --------------------------------------------------------------------- ui

  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; z-index: 2147483647; width: min(30rem, calc(100vw - 24px));
      background: #fff; color: #111; border: 1px solid #d7d7db; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.55 system-ui, sans-serif;
      overflow: hidden;
    }
    .head { display:flex; align-items:center; gap:8px; padding:8px 12px;
            border-bottom:1px solid #ececed; font-weight:600; font-size:12px; }
    .head .spacer { flex:1 }
    .body { padding: 10px 12px; max-height: 15rem; overflow:auto; white-space: pre-wrap;
            word-break: break-word; }
    .foot { display:flex; gap:8px; padding:8px 12px; border-top:1px solid #ececed;
            flex-wrap: wrap; align-items:center; }
    .foot .spacer { flex:1 }
    button { font: inherit; padding: 5px 11px; border-radius: 6px; border:1px solid #d7d7db;
             background:#fafafa; color:#111; cursor:pointer; }
    button:hover { background:#f0f0f2 }
    button.primary { background:#111; color:#fff; border-color:#111 }
    button.link { border:0; background:none; padding:5px 4px; color:#555;
                  text-decoration:underline; }
    del { background:#ffe3e3; color:#8c1c1c; text-decoration:line-through; }
    ins { background:#dcf5e3; color:#0f5c2b; text-decoration:none; }
    .muted { color:#666 }
    .spinner { width:12px; height:12px; border:2px solid #ccc; border-top-color:#111;
               border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg) } }
    .float { position:fixed; z-index:2147483646; border-radius:6px; padding:3px 8px;
             font:12px system-ui,sans-serif; background:#111; color:#fff; cursor:pointer;
             border:0; box-shadow:0 2px 8px rgba(0,0,0,.25) }
    input.custom { flex:1; min-width:8rem; padding:5px 8px; border:1px solid #d7d7db;
                   border-radius:6px; font:inherit }
    @media (prefers-color-scheme: dark) {
      .card { background:#1c1c1f; color:#eee; border-color:#34343a }
      .head, .foot { border-color:#2a2a30 }
      button { background:#26262b; color:#eee; border-color:#3a3a42 }
      button:hover { background:#303038 }
      button.primary { background:#eee; color:#111; border-color:#eee }
      button.link { color:#aaa }
      del { background:#4a1f1f; color:#ffb4b4 }
      ins { background:#12361f; color:#9ae6b4 }
      .muted { color:#999 }
    }
  `;

  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;
  let floater: HTMLButtonElement | null = null;

  function ui(): ShadowRoot {
    if (root) return root;
    host = document.createElement("div");
    host.setAttribute("data-ai-lang-adapt", "");
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
    document.documentElement.append(host);
    return root;
  }

  function place(card: HTMLElement, rect: DOMRect): void {
    const margin = 8;
    const w = Math.min(480, window.innerWidth - 24);
    let top = rect.bottom + margin;
    if (top + 220 > window.innerHeight) top = Math.max(margin, rect.top - 220 - margin);
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - w - margin);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function clearCard(): void {
    root?.querySelector(".card")?.remove();
  }

  function card(rect: DOMRect): HTMLDivElement {
    clearCard();
    const el = document.createElement("div");
    el.className = "card";
    ui().append(el);
    place(el, rect);
    return el;
  }

  // ---------------------------------------------------------------- request

  interface Session {
    capture: Capture;
    request: string | null;
    timer: number | null;
    closed: boolean;
  }

  let session: Session | null = null;

  const send = (msg: unknown): Promise<any> => chrome.runtime.sendMessage(msg);

  function endSession(cancel: boolean): void {
    if (!session) return;
    if (session.timer !== null) window.clearInterval(session.timer);
    if (cancel && session.request) void send({ type: "cancel", request: session.request });
    session.closed = true;
    session = null;
    clearCard();
  }

  function showError(rect: DOMRect, title: string, detail: string, configure = false): void {
    const el = card(rect);
    el.innerHTML = `<div class="head">${title}<div class="spacer"></div></div>
      <div class="body muted"></div>
      <div class="foot"><div class="spacer"></div></div>`;
    (el.querySelector(".body") as HTMLElement).textContent = detail;
    const foot = el.querySelector(".foot") as HTMLElement;
    if (configure) {
      const open = document.createElement("button");
      open.textContent = "Open options";
      open.onclick = () => void send({ type: "openOptions" });
      foot.append(open);
    }
    const close = document.createElement("button");
    close.className = "primary";
    close.textContent = "Close";
    close.onclick = () => endSession(false);
    foot.append(close);
  }

  function showPending(cap: Capture): void {
    const el = card(cap.rect());
    el.innerHTML = `<div class="head"><div class="spinner"></div>Rewriting…<div class="spacer"></div></div>
      <div class="body muted">Your agent is working on it. This takes a few seconds.</div>
      <div class="foot"><div class="spacer"></div></div>`;
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => endSession(true);
    (el.querySelector(".foot") as HTMLElement).append(cancel);
  }

  function showResult(cap: Capture, rewrite: string): void {
    const el = card(cap.rect());
    const supported = cap.tier !== "unsupported";
    el.innerHTML = `<div class="head">Suggestion<div class="spacer"></div></div>
      <div class="body"></div><div class="foot"></div>`;

    const body = el.querySelector(".body") as HTMLElement;
    const pieces = wordDiff(cap.original, rewrite);
    if (pieces) {
      for (const p of pieces) {
        const node =
          p.t === "eq"
            ? document.createTextNode(p.v)
            : Object.assign(document.createElement(p.t === "del" ? "del" : "ins"), {
                textContent: p.v,
              });
        body.append(node);
      }
    } else {
      body.textContent = rewrite;
    }

    const foot = el.querySelector(".foot") as HTMLElement;

    if (supported) {
      const accept = document.createElement("button");
      accept.className = "primary";
      accept.textContent = "Accept";
      accept.onclick = () => {
        const ok = cap.apply(rewrite);
        endSession(false);
        if (!ok) showError(cap.rect(), "Could not apply", "Copy it instead.");
      };
      foot.append(accept);
    } else {
      const copy = document.createElement("button");
      copy.className = "primary";
      copy.textContent = "Copy";
      copy.onclick = () => void navigator.clipboard.writeText(rewrite).then(() => endSession(false));
      foot.append(copy);
      const note = document.createElement("span");
      note.className = "muted";
      note.textContent = "This editor can't be written to safely.";
      foot.append(note);
    }

    // Q12: variants live on the result, where the user has something to react to.
    for (const [text, instruction] of [
      ["More formal", "Rewrite it in a more formal register."],
      ["Simpler", "Rewrite it using simpler, plainer words and shorter sentences."],
    ] as const) {
      const b = document.createElement("button");
      b.className = "link";
      b.textContent = text;
      b.onclick = () => start(cap, instruction);
      foot.append(b);
    }

    const custom = document.createElement("button");
    custom.className = "link";
    custom.textContent = "Custom…";
    custom.onclick = () => {
      custom.remove();
      const input = document.createElement("input");
      input.className = "custom";
      input.placeholder = "e.g. shorter, and less apologetic";
      input.onkeydown = (ev) => {
        if (ev.key === "Enter" && input.value.trim()) start(cap, input.value.trim());
      };
      foot.append(input);
      input.focus();
    };
    foot.append(custom);

    foot.append(Object.assign(document.createElement("div"), { className: "spacer" }));
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.onclick = () => endSession(false);
    foot.append(dismiss);
  }

  function start(cap: Capture, instruction: string | null = null): void {
    endSession(false);
    const s: Session = { capture: cap, request: null, timer: null, closed: false };
    session = s;
    showPending(cap);

    void (async () => {
      const res = await send({
        type: "submit",
        payload: {
          original: cap.original,
          context: cap.context,
          origin: location.origin,
          title: document.title.slice(0, 200),
          label: labelFor(cap.el),
          instruction,
        },
      });
      if (s.closed) return;

      if (!res?.ok) {
        const err = res?.body?.error;
        if (err === "unconfigured") {
          showError(cap.rect(), "Not set up yet", "Add your server address and token.", true);
        } else if (err === "busy") {
          showError(cap.rect(), "Already working", "One rewrite at a time — your agent is busy.");
        } else if (err === "unreachable" || res?.status === 0) {
          showError(cap.rect(), "No server", "Start the Loop with /adapt-loop in Claude Code.");
        } else {
          showError(cap.rect(), "Request failed", String(err ?? res?.status ?? "unknown"));
        }
        return;
      }

      s.request = res.body.request as string;
      // The content script owns the clock: a service worker would be killed mid-wait.
      s.timer = window.setInterval(() => void tick(s), 1000);
    })();
  }

  async function tick(s: Session): Promise<void> {
    if (s.closed || !s.request) return;
    const res = await send({ type: "result", request: s.request });
    if (s.closed) return;
    const status = res?.body?.status;

    if (status === "done") {
      window.clearInterval(s.timer!);
      s.timer = null;
      showResult(s.capture, String(res.body.rewrite));
    } else if (status === "nochange") {
      const rect = s.capture.rect();
      endSession(false);
      showError(rect, "Looks good already", "No changes worth making.");
    } else if (status === "expired" || status === "timeout" || status === "cancelled") {
      const rect = s.capture.rect();
      endSession(false);
      if (status === "expired") {
        showError(rect, "No agent", "Nobody picked this up. Is the Loop running in Claude Code?");
      } else if (status === "timeout") {
        showError(rect, "Too slow", "Your agent took the request but didn't answer in time.");
      }
    }
  }

  // -------------------------------------------------------------- triggers

  function trigger(): void {
    const cap = capture();
    if (!cap) return;
    if (cap.tier === "unsupported") {
      // Still worth running: the user gets the Rewrite to copy.
      start(cap);
      return;
    }
    start(cap);
  }

  chrome.runtime.onMessage.addListener((msg: { type: string }) => {
    if (msg.type === "trigger") trigger();
  });

  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape" && session) {
        endSession(true);
        ev.stopPropagation();
      }
    },
    true,
  );

  // Q17: the button appears only on a selection. A button on every focus is what
  // makes this class of extension feel invasive.
  let floatTimer = 0;
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(floatTimer);
    floatTimer = window.setTimeout(() => {
      floater?.remove();
      floater = null;
      if (session) return;

      const found = classify(document.activeElement);
      if (!found) return;
      const cap = capture();
      if (!cap || cap.context === null) return; // context !== null means "there is a selection"

      const rect = cap.rect();
      if (rect.width === 0 && rect.height === 0) return;

      const b = document.createElement("button");
      b.className = "float";
      b.textContent = "Fix";
      b.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 32)}px`;
      b.style.left = `${Math.max(8, rect.left)}px`;
      // mousedown, not click: click would land after the selection is already gone.
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        b.remove();
        floater = null;
        start(cap);
      });
      ui().append(b);
      floater = b;
    }, 250);
  });

  window.addEventListener(
    "scroll",
    () => {
      if (session) {
        const c = root?.querySelector(".card") as HTMLElement | null;
        if (c) place(c, session.capture.rect());
      }
      floater?.remove();
      floater = null;
    },
    true,
  );
})();
