/**
 * 文件说明：验证管理端脚本发布路由只接受 releaseId 并透传灰度比例。
 */

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAdminRoutes } from "../dist/admin.js";

async function createApp(records) {
  const app = Fastify();
  await registerAdminRoutes(app, {
    ensureBuiltinAdminUser: async () => {},
    authRequired: async (request) => {
      request.adminUser = "tester";
    },
    publishScriptRelease: async (...args) => {
      records.publish.push(args);
      return { releaseId: args[0], releaseStage: args[1], rolloutPercent: args[2], issueId: "", scriptKey: "key", parentReleaseId: "" };
    },
    rollbackScriptRelease: async (...args) => {
      records.rollback.push(args);
      return { releaseId: args[0], releaseStage: "rolled_back", rolloutPercent: 0, issueId: "", scriptKey: "key", parentReleaseId: "" };
    },
    disableScriptRelease: async (...args) => {
      records.disable.push(args);
      return { releaseId: args[0], releaseStage: "disabled", rolloutPercent: 0, issueId: "", scriptKey: "key", parentReleaseId: "" };
    },
    createUploadedScriptRelease: async (...args) => {
      records.upload.push(args);
      return { releaseId: "rel-upload", scriptKey: "key", version: 2, validationStatus: "passed", validationReport: {} };
    },
    revalidateScriptRelease: async (...args) => {
      records.revalidate.push(args);
      return { releaseId: args[0], scriptKey: "key", version: 2, validationStatus: "passed", validationReport: {} };
    }
  });
  return app;
}

test("灰度发布按 releaseId 透传 1 到 99 的比例", async () => {
  const records = { publish: [], rollback: [], disable: [], upload: [], revalidate: [] };
  const app = await createApp(records);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/scripts/releases",
    payload: { releaseId: "rel-a", releaseStage: "canary", rolloutPercent: 10 }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(records.publish[0], ["rel-a", "canary", 10, "tester"]);
  await app.close();
});

test("旧按 scriptName 发布接口不再执行模糊操作", async () => {
  const records = { publish: [], rollback: [], disable: [], upload: [], revalidate: [] };
  const app = await createApp(records);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/promote_script",
    payload: { scriptName: "zhengfang.js", stage: "active" }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(records.publish.length, 0);
  await app.close();
});

test("回滚和停用路由均使用 releaseId", async () => {
  const records = { publish: [], rollback: [], disable: [], upload: [], revalidate: [] };
  const app = await createApp(records);
  const rollback = await app.inject({ method: "POST", url: "/api/v1/admin/scripts/releases/rel-a/rollback" });
  const disable = await app.inject({
    method: "POST",
    url: "/api/v1/admin/scripts/releases/rel-a/disable",
    payload: { reason: "线上异常" }
  });

  assert.equal(rollback.statusCode, 200);
  assert.equal(disable.statusCode, 200);
  assert.deepEqual(records.rollback[0], ["rel-a", "tester"]);
  assert.deepEqual(records.disable[0], ["rel-a", "线上异常", "tester"]);
  await app.close();
});

test("候选上传透传完整作用域与人工验证字段", async () => {
  const records = { publish: [], rollback: [], disable: [], upload: [], revalidate: [] };
  const app = await createApp(records);
  const payload = {
    name: "zf_autofill.js",
    category: "js",
    targetType: "navigation",
    scopeKind: "school",
    scopeId: "school-a",
    schoolSystemType: "ZF",
    content: "(() => true)();",
    changelog: "manual upload",
    testSchoolId: "school-a",
    pageStage: "login",
    manualValidationResult: "passed",
    manualValidationPassed: true
  };
  const response = await app.inject({ method: "POST", url: "/api/v1/admin/scripts/uploads", payload });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(records.upload[0], [payload, "tester"]);
  await app.close();
});

test("重新验证只按 releaseId 更新原版本", async () => {
  const records = { publish: [], rollback: [], disable: [], upload: [], revalidate: [] };
  const app = await createApp(records);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/scripts/releases/rel-a/revalidate",
    payload: { testSchoolId: "school-a", manualValidationPassed: true }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(records.revalidate[0], ["rel-a", { testSchoolId: "school-a", manualValidationPassed: true }, "tester"]);
  await app.close();
});
