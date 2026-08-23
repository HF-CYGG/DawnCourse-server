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

test("parse_task uses durable task store without depending on route memory Map", async () => {
  const app = Fastify();
  const savedTasks = new Map();
  const cloudTaskStore = {
    async create(task) {
      savedTasks.set(task.taskId, { ...task });
    },
    async update(taskId, patch) {
      savedTasks.set(taskId, { ...savedTasks.get(taskId), ...patch });
    },
    async get(taskId) {
      return savedTasks.get(taskId) || null;
    }
  };

  await registerCollectorRoutes(app, {
    cloudTaskStore,
    ingestParseReport: async () => ({ issueId: "issue-persisted", repairDomain: "PARSER", targetType: "parser", queued: true }),
    getRuntimeModelConfig: async () => createSummaryConfig(),
    scheduleCloudParseTask: async ({ taskId, cloudTaskStore: store }) => {
      await store.update(taskId, {
        status: "success",
        result: '[{"name":"大学英语"}]',
        completedAt: Date.now()
      });
    }
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-persisted",
      userConsent: true,
      sanitizedContent: "星期一 大学英语 1-2节"
    }
  });
  const created = createResponse.json();
  assert.equal(created.code, 200);
  assert.equal(savedTasks.size, 1);

  const statusResponse = await app.inject({
    method: "GET",
    url: `/api/v1/task_status?taskId=${created.data.taskId}`
  });
  const status = statusResponse.json();
  assert.equal(status.code, 200);
  assert.equal(status.data.status, "success");
  assert.equal(status.data.result, '[{"name":"大学英语"}]');
  assert.equal(status.data.issueId, "issue-persisted");

  await app.close();
});
