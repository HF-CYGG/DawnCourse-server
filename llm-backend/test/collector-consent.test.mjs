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

test("parse_task requires explicit consent before storing or submitting sanitized content", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-no-explicit-consent", repairDomain: "PARSER", targetType: "parser", queued: false };
    },
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-implicit",
      sanitizedContent: "course table html"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 400);
  assert.equal(body.data.issueId, "issue-no-explicit-consent");
  assert.equal(localTaskStore.size, 0);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].sanitizedSample.hasUserConsent, false);
  assert.equal(reported[0].sanitizedSample.content, "");

  await app.close();
});
