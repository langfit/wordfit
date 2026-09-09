import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store writes Request files relative to cwd; keep them out of the repo.
process.chdir(mkdtempSync(join(tmpdir(), "adapt-test-")));

const { RequestStore, BusyError, toPolled } = await import("../dist/store.js");

const input = (original = "hello") => ({
  original,
  context: null,
  targetLanguage: "English",
  origin: "https://example.com",
  title: "t",
  label: null,
  instruction: null,
});

test("one Request in flight at a time", () => {
  const store = new RequestStore();
  store.submit(input());
  assert.throws(() => store.submit(input("second")), BusyError);
});

test("a Request the agent never picks up expires", () => {
  const store = new RequestStore();
  const req = store.submit(input());
  req.expiresAt = Date.now() - 1;
  assert.equal(store.stateOf(req.id).status, "expired");
  // ...and the slot frees up, rather than wedging the extension forever.
  assert.doesNotThrow(() => store.submit(input("next")));
});

test("a Request an agent took but did not answer is a timeout, not an expiry", async () => {
  // The user can act on "no agent"; they can only wait out "agent too slow". The
  // extension says different things, so the store has to tell them apart.
  const store = new RequestStore();
  const req = store.submit(input());
  await store.poll(100); // an agent takes it
  req.expiresAt = Date.now() - 1;
  assert.equal(store.stateOf(req.id).status, "timeout");
});

test("poll gives the agent the text, not just a path", async () => {
  const store = new RequestStore();
  store.submit(input("I has go to store."));
  const polled = await store.poll(100);
  assert.equal(toPolled(polled).originalText, "I has go to store.");
});

test("a Rewrite that arrives after the deadline is refused, not applied", () => {
  const store = new RequestStore();
  const req = store.submit(input());
  req.expiresAt = Date.now() - 1;
  assert.equal(store.respond(req.id, { rewrite: "too late" }), false);
  assert.equal(store.stateOf(req.id).status, "expired");
});

test("poll hands over a pending Request and marks it serving", async () => {
  const store = new RequestStore();
  const req = store.submit(input());
  const polled = await store.poll(1000);
  assert.equal(polled.id, req.id);
  assert.equal(polled.state.status, "serving");
});

test("poll resolves idle when nothing arrives", async () => {
  const store = new RequestStore();
  assert.equal(await store.poll(50), null);
});

test("a waiting agent is handed the next Request immediately", async () => {
  const store = new RequestStore();
  const waiting = store.poll(2000);
  const req = store.submit(input("typed while the agent waited"));
  assert.equal((await waiting).id, req.id);
});

test("noChange and cancel are distinct terminal states", () => {
  const store = new RequestStore();
  const a = store.submit(input());
  store.respond(a.id, { noChange: true });
  assert.equal(store.stateOf(a.id).status, "nochange");

  const b = store.submit(input());
  store.cancel(b.id);
  assert.equal(store.stateOf(b.id).status, "cancelled");
});
