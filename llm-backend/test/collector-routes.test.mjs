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

test("parse_task 以 canonical importSessionId 创建任务、Issue 与持久记录", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const durableTasks = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    cloudTaskStore: {
      async create(task) {
        durableTasks.set(task.taskId, { ...task });
      },
      async update(taskId, patch) {
        durableTasks.set(taskId, { ...durableTasks.get(taskId), ...patch });
      },
      async get(taskId) {
        return durableTasks.get(taskId) || null;
      }
    },
    ingestParseReport: async (body, source) => {
      reported.push({ body, source });
      return { issueId: "issue-success", repairDomain: "PARSER", targetType: "parser", queued: true };
    },
    getRuntimeModelConfig: async () => createSummaryConfig(),
    scheduleCloudParseTask: async ({ taskId, taskStore, cloudTaskStore }) => {
      const patch = {
        status: "success",
        result: '[{"name":"高等数学"}]',
        completedAt: Date.now()
      };
      taskStore.set(taskId, { ...taskStore.get(taskId), ...patch });
      await cloudTaskStore.update(taskId, patch);
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      importSessionId: "import-sess-1",
      profileId: "local-profile-must-not-leak",
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
  assert.equal(reported[0].body.session.importSessionId, "import-sess-1");
  assert.equal(reported[0].body.sanitizedSample.sanitizerVersion, 1);
  assert.equal(Object.hasOwn(reported[0].body.session, "parseSessionId"), false);
  assert.equal(Object.hasOwn(reported[0].body.session, "profileId"), false);
  assert.equal(durableTasks.get(created.data.taskId).importSessionId, "import-sess-1");
  assert.equal(Object.hasOwn(durableTasks.get(created.data.taskId), "profileId"), false);
  assert.equal(JSON.stringify(created).includes("profileId"), false);

  const statusResponse = await app.inject({
    method: "GET",
    url: `/api/v1/task_status?taskId=${created.data.taskId}`
  });
  assert.equal(statusResponse.statusCode, 200);
  const statusBody = statusResponse.json();
  assert.equal(statusBody.code, 200);
  assert.equal(statusBody.data.status, "success");
  assert.equal(statusBody.data.result, '[{"name":"高等数学"}]');
  assert.equal(statusBody.data.importSessionId, "import-sess-1");
  assert.equal(JSON.stringify(statusBody).includes("profileId"), false);

  await app.close();
});

test("parse/report 优先 canonical importSessionId，并只把 legacy 字段作为入站回退", async () => {
  const app = Fastify();
  const reported = [];
  await registerCollectorRoutes(app, {
    ingestParseReport: async (body, source) => {
      reported.push({ body, source });
      return { issueId: "issue-report", repairDomain: "PARSER", targetType: "parser", queued: false };
    }
  });

  const canonicalResponse = await app.inject({
    method: "POST",
    url: "/api/v1/parse/report",
    payload: {
      session: {
        importSessionId: "import-report",
        parseSessionId: "legacy-must-lose",
        profileId: "local-profile-must-not-leak"
      }
    }
  });
  const legacyResponse = await app.inject({
    method: "POST",
    url: "/api/v1/parse/report",
    payload: { session: { parseSessionId: "legacy-report" } }
  });

  assert.equal(canonicalResponse.statusCode, 200);
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(reported[0].source, "parse_report");
  assert.equal(reported[0].body.session.importSessionId, "import-report");
  assert.equal(Object.hasOwn(reported[0].body.session, "parseSessionId"), false);
  assert.equal(Object.hasOwn(reported[0].body.session, "profileId"), false);
  assert.equal(reported[1].body.session.importSessionId, "legacy-report");
  assert.equal(Object.hasOwn(reported[1].body.session, "parseSessionId"), false);

  await app.close();
});

test("parse/report session 仅保留显式 allowlist，丢弃所有 Profile 与未知嵌套字段", async () => {
  const app = Fastify();
  const reported = [];
  await registerCollectorRoutes(app, {
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-allowlist", repairDomain: "PARSER", targetType: "parser", queued: false };
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse/report",
    payload: {
      session: {
        importSessionId: "import-allowlist",
        appVersionCode: 42,
        appVersionName: "2.0.0",
        installBucketIdHash: "hash",
        importSource: "WEBVIEW",
        schoolId: "school-1",
        schoolName: "Dawn University",
        schoolSystemType: "ZF",
        sourceUrl: "https://example.edu/timetable",
        activeProfileId: "profile-active",
        profileUuid: "profile-uuid",
        profile: { id: "nested-profile", token: "must-not-reach-storage" },
        unknownDiagnosticField: { profileId: "also-must-not-reach-storage" }
      }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(reported[0].session, {
    importSessionId: "import-allowlist",
    appVersionCode: 42,
    appVersionName: "2.0.0",
    installBucketIdHash: "hash",
    importSource: "WEBVIEW",
    schoolId: "school-1",
    schoolName: "Dawn University",
    schoolSystemType: "ZF",
    sourceUrl: "https://example.edu/timetable"
  });
  assert.equal(JSON.stringify(reported[0]).includes("profile"), false);
  assert.equal(JSON.stringify(response.json()).includes("profile"), false);

  await app.close();
});

test("parse/report 对整个报告深层 allowlist，Profile 数据不能进入 DB 序列化或响应", async () => {
  const app = Fastify();
  const reported = [];
  await registerCollectorRoutes(app, {
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-deep-allowlist", repairDomain: "PARSER_FAILURE", targetType: "parser", queued: false };
    }
  });

  const leakedValues = [
    "PROFILE_TOP_LEVEL",
    "PROFILE_FINGERPRINT",
    "PROFILE_ATTEMPT",
    "PROFILE_ATTEMPT_RAW_JSON",
    "PROFILE_SAMPLE",
    "PROFILE_CLASSIFICATION"
  ];
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse/report",
    payload: {
      profileId: "PROFILE_TOP_LEVEL",
      profile: { uuid: "PROFILE_TOP_LEVEL" },
      session: { importSessionId: "import-deep-allowlist" },
      pageFingerprint: {
        host: "jw.example.edu.cn",
        pathPattern: "/timetable",
        hasCourseKeyword: true,
        profileId: "PROFILE_FINGERPRINT",
        profile: { uuid: "PROFILE_FINGERPRINT" }
      },
      attempts: [
        {
          parserName: "zhengfang.js",
          parserVersion: 3,
          success: false,
          safeErrorCode: "PARSER_EMPTY",
          profileUuid: "PROFILE_ATTEMPT",
          raw_json: { profileId: "PROFILE_ATTEMPT_RAW_JSON" },
          nested: { profile: { uuid: "PROFILE_ATTEMPT" } }
        }
      ],
      finalSuccess: false,
      finalFailureType: "parser_empty",
      failureStage: "PARSE",
      repairDomain: "PARSER_FAILURE",
      targetType: "parser",
      sourceUrl: "https://jw.example.edu.cn/timetable",
      consentAt: 1700000000000,
      sanitizedSample: {
        hasUserConsent: true,
        sanitizerVersion: 2,
        contentSha256: "safe-sha256",
        content: "<table>sanitized timetable</table>",
        profileUuid: "PROFILE_SAMPLE",
        profile: { id: "PROFILE_SAMPLE" }
      },
      classificationHint: {
        profileId: "PROFILE_CLASSIFICATION",
        nested: { PROFILE: { uuid: "PROFILE_CLASSIFICATION" } }
      }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(reported, [
    {
      session: { importSessionId: "import-deep-allowlist" },
      pageFingerprint: {
        host: "jw.example.edu.cn",
        pathPattern: "/timetable",
        hasCourseKeyword: true
      },
      attempts: [
        {
          parserName: "zhengfang.js",
          parserVersion: 3,
          success: false,
          safeErrorCode: "PARSER_EMPTY"
        }
      ],
      finalSuccess: false,
      finalFailureType: "parser_empty",
      failureStage: "PARSE",
      repairDomain: "PARSER_FAILURE",
      targetType: "parser",
      sourceUrl: "https://jw.example.edu.cn/timetable",
      consentAt: 1700000000000,
      sanitizedSample: {
        hasUserConsent: true,
        sanitizerVersion: 2,
        contentSha256: "safe-sha256",
        content: "<table>sanitized timetable</table>"
      }
    }
  ]);

  // 这里的序列化与 collector 实际传给 page_fingerprint_json、parser_attempts.raw_json
  // 及 failure_samples 字段的值一致，防止未来再次把客户端自由对象写进数据库。
  const dbParameters = [
    JSON.stringify(reported[0].pageFingerprint),
    JSON.stringify(reported[0].attempts[0]),
    JSON.stringify(reported[0].sanitizedSample)
  ];
  const eventResponse = JSON.stringify(response.json());
  for (const leakedValue of leakedValues) {
    assert.equal(JSON.stringify(reported[0]).includes(leakedValue), false);
    assert.equal(dbParameters.some((value) => value.includes(leakedValue)), false);
    assert.equal(eventResponse.includes(leakedValue), false);
  }

  await app.close();
});

test("非法 importSessionId 不会入库或回显，改用服务端生成的 sess ID", async () => {
  const app = Fastify();
  const reported = [];
  await registerCollectorRoutes(app, {
    ingestParseReport: async (body) => {
      reported.push(body);
      return { issueId: "issue-invalid-session", repairDomain: "PARSER", targetType: "parser", queued: false };
    }
  });
  const invalidSessionIds = ["x".repeat(129), "../../profile/secret", { nested: "session" }];

  for (const importSessionId of invalidSessionIds) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parse/report",
      payload: { session: { importSessionId } }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(response.json()).includes(JSON.stringify(importSessionId)), false);
  }

  assert.equal(reported.length, invalidSessionIds.length);
  for (const report of reported) {
    assert.match(report.session.importSessionId, /^sess_[a-f0-9]{16}$/);
    assert.equal(report.session.importSessionId.includes("profile"), false);
  }

  await app.close();
});

test("parse_task 在未同意上传时返回 400，且不创建任务", async () => {
  const app = Fastify();
  const localTaskStore = new Map();
  const reported = [];
  await registerCollectorRoutes(app, {
    taskStore: localTaskStore,
    ingestParseReport: async (report) => {
      reported.push(report);
      return { issueId: "issue-no-consent", repairDomain: "PARSER", targetType: "parser", queued: false };
    },
    getRuntimeModelConfig: async () => createSummaryConfig()
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parse_task",
    payload: {
      parseSessionId: "sess-2",
      userConsent: false,
      sanitizedContent: "课程内容"
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.code, 400);
  assert.equal(body.data.issueId, "issue-no-consent");
  assert.equal(localTaskStore.size, 0);
  assert.equal(reported[0].session.importSessionId, "sess-2");
  assert.equal(Object.hasOwn(reported[0].session, "parseSessionId"), false);

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
