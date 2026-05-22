/**
 * 文件说明：验证解析失败上报后的自动修复触发链路。
 * 重点覆盖“样本阈值未达标不触发、达标后触发修复”这两个可重复回归的关键分支。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { triggerRepairIfReady } from "../dist/collector.js";

test("样本数未达到阈值时只记录等待事件，不启动修复", async () => {
  const record = { startRepairJob: [], addIssueEvent: [] };
  const started = await triggerRepairIfReady(
    {
      issueId: "issue-waiting",
      queued: true,
      hasSample: true
    },
    {
      getRuntimePlatformConfig: async () => ({
        publicBaseUrl: "",
        runnerUrl: "http://localhost",
        minQueueSize: 3,
        runnerTimeoutMs: 5000
      }),
      query: async () => ({
        rows: [{ sample_count: 2 }]
      }),
      startRepairJob: async (issueId, options) => {
        record.startRepairJob.push({ issueId, options });
        return { jobId: "job-1", started: true };
      },
      addIssueEvent: async (event) => {
        record.addIssueEvent.push(event);
      }
    }
  );

  assert.equal(started, false);
  assert.equal(record.startRepairJob.length, 0);
  assert.equal(record.addIssueEvent.length, 1);
  assert.equal(record.addIssueEvent[0].issueId, "issue-waiting");
  assert.match(record.addIssueEvent[0].message, /等待达到最小样本数 3/);
});

test("样本数达到阈值时启动自动修复", async () => {
  const record = { startRepairJob: [], addIssueEvent: [] };
  const started = await triggerRepairIfReady(
    {
      issueId: "issue-ready",
      queued: true,
      hasSample: true
    },
    {
      getRuntimePlatformConfig: async () => ({
        publicBaseUrl: "",
        runnerUrl: "http://localhost",
        minQueueSize: 3,
        runnerTimeoutMs: 5000
      }),
      query: async () => ({
        rows: [{ sample_count: 3 }]
      }),
      startRepairJob: async (issueId, options) => {
        record.startRepairJob.push({ issueId, options });
        return { jobId: "job-2", started: true };
      },
      addIssueEvent: async (event) => {
        record.addIssueEvent.push(event);
      }
    }
  );

  assert.equal(started, true);
  assert.deepEqual(record.startRepairJob, [
    {
      issueId: "issue-ready",
      options: { actor: "collector", bypassMinQueue: false }
    }
  ]);
  assert.equal(record.addIssueEvent.length, 0);
});

test("未排队或没有样本时直接跳过触发链路", async () => {
  const record = { startRepairJob: 0 };
  const started = await triggerRepairIfReady(
    {
      issueId: "issue-skip",
      queued: false,
      hasSample: false
    },
    {
      startRepairJob: async () => {
        record.startRepairJob += 1;
        return { jobId: "job-3", started: true };
      }
    }
  );

  assert.equal(started, false);
  assert.equal(record.startRepairJob, 0);
});
