import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResultForTest } from "../../script-runner/runner.js";

test("runner rejects parser courses without courseName", () => {
  const result = normalizeResultForTest("parser", [
    { dayOfWeek: 1, startSection: 1, duration: 2, startWeek: 1, endWeek: 16 }
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("runner rejects term extractor results without label and value", () => {
  const result = normalizeResultForTest("term_extractor", [{ label: "2025-2026" }]);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("runner rejects navigation results without action and target", () => {
  const result = normalizeResultForTest("navigation", { foo: "bar" });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});
