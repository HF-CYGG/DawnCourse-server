import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeBaselineReportsForTest,
  summarizeCandidateReportsForTest,
  summarizeRegressionReportsForTest
} from "../dist/repair.js";

const passed = { ok: true, schemaValid: true, resultCount: 3 };
const empty = { ok: true, schemaValid: true, resultCount: 0 };
const invalid = { ok: true, schemaValid: false, resultCount: 3 };
const crashed = { ok: false, schemaValid: false, resultCount: 0, errorCode: "script_exception" };

test("baseline replay is reproduced only when every authorized sample still fails", () => {
  assert.equal(summarizeBaselineReportsForTest([empty, invalid, crashed]).reproduced, true);
  assert.equal(summarizeBaselineReportsForTest([empty, passed]).reproduced, false);
});

test("candidate test passes only when every current issue sample is valid and non-empty", () => {
  assert.equal(summarizeCandidateReportsForTest([passed, { ...passed, resultCount: 1 }]).passed, true);
  assert.equal(summarizeCandidateReportsForTest([passed, empty]).passed, false);
  assert.equal(summarizeCandidateReportsForTest([passed, invalid]).passed, false);
});

test("regression summary allows limited regression but fails on historical regression failure", () => {
  assert.deepEqual(summarizeRegressionReportsForTest([]), { status: "limited_regression", passed: true });
  assert.deepEqual(summarizeRegressionReportsForTest([passed, { ...passed, resultCount: 1 }]), { status: "passed", passed: true });
  assert.deepEqual(summarizeRegressionReportsForTest([passed, crashed]), { status: "failed", passed: false });
});
