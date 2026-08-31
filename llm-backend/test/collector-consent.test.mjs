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
      importSessionId: "import-implicit",
      profileId: "local-profile-must-not-leak",
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
  assert.equal(reported[0].session.importSessionId, "import-implicit");
  assert.equal(Object.hasOwn(reported[0].session, "profileId"), false);

  await app.close();
});

test("parse_task 拒绝 raw-only content/html，且不进入上报或任务链路", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-raw-rejected", repairDomain: "PARSER", targetType: "parser", queued: false };
    },
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const rawPayloads = [
    { content: "raw student page must never become a sample" },
    { html: "<html>raw PII</html>" }
  ];
  for (const rawPayload of rawPayloads) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parse_task",
      payload: {
        importSessionId: "import-raw-rejected",
        userConsent: true,
        ...rawPayload
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().code, 400);
    for (const rawValue of Object.values(rawPayload)) {
      assert.equal(JSON.stringify(response.json()).includes(rawValue), false);
    }
  }

  assert.equal(localTaskStore.size, 0);
  assert.equal(reported.length, 0);

  await app.close();
});

test("parse_task 即使同时带 sanitizedContent 也拒绝顶层 raw 字段", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-raw-plus-sanitized", repairDomain: "PARSER", targetType: "parser", queued: false };
    },
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const rawValue = "raw profile page must never reach storage";
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      importSessionId: "import-raw-plus-sanitized",
      userConsent: true,
      sanitizerVersion: 1,
      sanitizedContent: "sanitized timetable",
      content: rawValue
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().code, 400);
  assert.equal(JSON.stringify(response.json()).includes(rawValue), false);
  assert.equal(localTaskStore.size, 0);
  assert.equal(reported.length, 0);

  await app.close();
});

test("parse_task 拒绝显式非有限或非正 sanitizerVersion，且不创建任务", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (body) => {
      reported.push(body);
      return {
        issueId: "issue-invalid-sanitizer-version",
        repairDomain: "PARSER",
        targetType: "parser",
        queued: false
      };
    },
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  for (const sanitizerVersion of [0, -1, "NaN", "Infinity"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parse_task",
      payload: {
        importSessionId: "import-invalid-sanitizer",
        userConsent: true,
        sanitizedContent: "sanitized timetable",
        sanitizerVersion
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().code, 400, `sanitizerVersion=${sanitizerVersion} must be rejected`);
    assert.equal(localTaskStore.size, 0);
  }
  assert.equal(reported.length, 0);

  await app.close();
});
