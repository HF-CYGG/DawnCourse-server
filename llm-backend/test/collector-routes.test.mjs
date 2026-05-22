/**
 * 文件说明：验证 collector 关键路由的轻量集成测试。
 * 目标是在无 Docker、无 PostgreSQL、无 Redis 的环境下，仍可重复回归 parse_task 与 task_status。
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerCollectorRoutes } from "../dist/collector.js";

function createSummaryConfig() {
  return {
    provider: "gpt",
    model: "gpt-4o-mini",
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    apiStyle: "auto",
    extraBody: "",
    timeoutMs: 1000
  };
}

test("parse_task 成功创建任务后可通过 task_status 查询结果", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (body, source) => {
      reported.push({ body, source });
      return { issueId: "issue-success", repairDomain: "PARSER", targetType: "parser", queued: true };
    },
    getRuntimeModelConfig: async () => createSummaryConfig(),
    scheduleCloudParseTask: async ({ taskId, taskStore }) => {
      taskStore.set(taskId, {
        ...taskStore.get(taskId),
        status: "success",
        result: '[{"name":"高等数学"}]',
        completedAt: Date.now()
      });
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-1",
      userConsent: true,
      sanitizedContent: "课程内容"
    }
  });
  assert.equal(response.statusCode, 200);
  const created = response.json();
  assert.equal(created.code, 200);
  assert.equal(created.data.issueId, "issue-success");
  assert.equal(created.data.status, "processing");
  assert.equal(reported.length, 1);

  const statusResponse = await app.inject({
    method: "GET",
    url: `/api/v1/task_status?taskId=${created.data.taskId}`
  });
  assert.equal(statusResponse.statusCode, 200);
  const statusBody = statusResponse.json();
  assert.equal(statusBody.code, 200);
  assert.equal(statusBody.data.status, "success");
  assert.equal(statusBody.data.result, '[{"name":"高等数学"}]');

  await app.close();
});

test("parse_task 在未同意上传时返回 400，且不创建任务", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async () => ({ issueId: "issue-no-consent", repairDomain: "PARSER", targetType: "parser", queued: false }),
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-2",
      userConsent: false,
      content: "课程内容"
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 400);
  assert.equal(body.data.issueId, "issue-no-consent");
  assert.equal(localTaskStore.size, 0);

  await app.close();
});

test("parse_task 在缺少可用内容时返回 400", async () => {
  const app = Fastify();
  await registerCollectorRoutes(app, {
    taskStore: new Map(),
    ingestParseReport: async () => ({ issueId: "issue-empty", repairDomain: "PARSER", targetType: "parser", queued: false }),
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-3",
      userConsent: true,
      sanitizedContent: ""
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 400);
  assert.equal(body.data.issueId, "issue-empty");

  await app.close();
});

test("task_status 在任务不存在时返回 404", async () => {
  const app = Fastify();
  await registerCollectorRoutes(app, { taskStore: new Map() });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/task_status?taskId=missing-task"
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 404);
  assert.equal(body.data.error, "task_not_found");

  await app.close();
});
