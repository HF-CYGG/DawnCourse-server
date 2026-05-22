/**
 * 文件说明：验证运维后台修复相关关键路由的轻量集成测试。
 * 这些测试通过注入鉴权与修复依赖，确保本地无数据库时也能回归关键操作行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAdminRoutes } from "../dist/admin.js";

async function registerTestAdminApp(record) {
  const app = Fastify();
  await registerAdminRoutes(app, {
    ensureBuiltinAdminUser: async () => {},
    authRequired: async (request) => {
      request.adminUser = "tester";
    },
    runReplayOnly: async (issueId, actor) => {
      record.runReplayOnly.push({ issueId, actor });
      return { ok: true, reportId: "report-1" };
    },
    startRepairJob: async (issueId, options) => {
      record.startRepairJob.push({ issueId, options });
      return { jobId: `job-${record.startRepairJob.length}`, started: true };
    },
    addIssueEvent: async (event) => {
      record.addIssueEvent.push(event);
    }
  });
  return app;
}

test("run-test 路由返回回放结果并带上操作人", async () => {
  const record = { runReplayOnly: [], startRepairJob: [], addIssueEvent: [] };
  const app = await registerTestAdminApp(record);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/repair/issues/issue-1/run-test"
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.ok, true);
  assert.equal(body.data.reportId, "report-1");
  assert.equal(body.data.testedBy, "tester");
  assert.deepEqual(record.runReplayOnly, [{ issueId: "issue-1", actor: "tester" }]);

  await app.close();
});

test("retry 路由以保留最小样本限制方式触发修复", async () => {
  const record = { runReplayOnly: [], startRepairJob: [], addIssueEvent: [] };
  const app = await registerTestAdminApp(record);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/repair/issues/issue-2/retry"
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.started, true);
  assert.deepEqual(record.startRepairJob, [
    {
      issueId: "issue-2",
      options: { actor: "tester", bypassMinQueue: false }
    }
  ]);

  await app.close();
});

test("force-repair 路由会先记录事件，再忽略最小样本限制触发修复", async () => {
  const record = { runReplayOnly: [], startRepairJob: [], addIssueEvent: [] };
  const app = await registerTestAdminApp(record);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/repair/issues/issue-3/force-repair"
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.started, true);
  assert.equal(record.addIssueEvent.length, 1);
  assert.equal(record.addIssueEvent[0].issueId, "issue-3");
  assert.equal(record.addIssueEvent[0].source, "admin_force_repair");
  assert.deepEqual(record.startRepairJob, [
    {
      issueId: "issue-3",
      options: { actor: "tester", bypassMinQueue: true }
    }
  ]);

  await app.close();
});
