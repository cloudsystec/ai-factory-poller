import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "./billing-settle-service.js";

test("billing-settle-service exports", () => {
  assert.equal(typeof mod.loadConsumedKeys, "function");
  assert.equal(typeof mod.sumJobBillingCalls, "function");
  assert.equal(typeof mod.listCallsAwaitingCursorSettle, "function");
  assert.equal(typeof mod.applyCursorMatchToCall, "function");
  assert.equal(typeof mod.billingCallAnchorMs, "function");
  assert.equal(typeof mod.areAllJobCallsSettled, "function");
});

test("billingCallAnchorMs prefere ended_at", () => {
  const ended = new Date("2026-05-30T12:00:00Z");
  const started = new Date("2026-05-30T11:00:00Z");
  assert.equal(
    mod.billingCallAnchorMs(started, ended),
    ended.getTime()
  );
  assert.equal(
    mod.billingCallAnchorMs(started, null),
    started.getTime()
  );
});
