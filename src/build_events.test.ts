import test from "node:test";
import assert from "node:assert/strict";
import { BuildEvent, ReleaseRequest, triage } from "./build_events.ts";

const base = {
  build_id: "b-1",
  repo: "acme/cli",
  branch: "main",
  status: "failed" as const,
  duration_ms: 91_000,
  attempt: 1,
  log_tail: "npm ERR! ETIMEDOUT",
};

test("a flaky infrastructure step retries instead of burning a model call", () => {
  const event = BuildEvent.parse({ ...base, failed_step: "fetch-deps" });
  assert.deepEqual(triage(event).action, "auto_retry");
});

test("a compile failure goes to diagnosis", () => {
  const event = BuildEvent.parse({ ...base, failed_step: "tsc" });
  const decision = triage(event);
  assert.equal(decision.action, "diagnose");
  assert.match(decision.reason, /tsc/);
});

test("main red on the third attempt pages on-call, flaky step or not", () => {
  const event = BuildEvent.parse({ ...base, failed_step: "fetch-deps", attempt: 3 });
  assert.equal(triage(event).action, "page_oncall");
});

test("green builds release", () => {
  const event = BuildEvent.parse({ ...base, status: "passed", failed_step: undefined });
  assert.equal(triage(event).action, "release");
});

test("a release body without release_id is rejected at the boundary", () => {
  const parsed = ReleaseRequest.safeParse({
    repo: "acme/cli",
    version: "1.4.0",
    event: { ...base, failed_step: "tsc" },
  });
  assert.equal(parsed.success, false);
});
