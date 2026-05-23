/**
 * 文件说明：验证失败上报入库后的阶段决策，避免无需自动修复的问题被错误标成 SAMPLE_READY。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolvePostIngestPolicy } from "../dist/collector.js";

test("有样本且允许自动修复时进入 SAMPLE_READY 并排队", () => {
  const result = resolvePostIngestPolicy({
    hasSample: true,
    shouldAutoRepair: true
  });

  assert.deepEqual(result, {
    nextStage: "SAMPLE_READY",
    queued: true
  });
});

test("有样本但无需自动修复时保持 REPORTED，不进入 SAMPLE_READY", () => {
  const result = resolvePostIngestPolicy({
    hasSample: true,
    shouldAutoRepair: false
  });

  assert.deepEqual(result, {
    nextStage: "ISSUE_MERGED",
    queued: false
  });
});

test("没有样本时不排队且保持 REPORTED", () => {
  const result = resolvePostIngestPolicy({
    hasSample: false,
    shouldAutoRepair: true
  });

  assert.deepEqual(result, {
    nextStage: "ISSUE_MERGED",
    queued: false
  });
});
