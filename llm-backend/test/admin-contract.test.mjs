/**
 * 文件说明：运维后台契约测试。
 * 负责验证 `/api/v1/admin/script_history` 与 `/api/v1/admin/runtime_logs` 依赖的纯函数输出，
 * 确保返回结构与当前 `server/html/admin/admin.js` 的读取方式一致。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeLogPayload, buildScriptHistoryEntries, formatAdminBufferLine } from "../dist/adminContracts.js";

test("runtime_logs 契约包含 admin.js 需要的摘要字段", () => {
  const payload = buildRuntimeLogPayload({
    requestedSource: "all",
    resolvedSource: "all",
    requestedLimit: 500,
    lines: ["[backend] line-1", "[admin-buffer] line-2"],
    files: {
      backend: "/tmp/backend.log",
      nginx_access: "/tmp/access.log",
      nginx_error: "/tmp/error.log",
      admin: "adminLogBuffer"
    },
    sourceCounts: {
      backend: 1,
      nginx_access: 0,
      nginx_error: 0,
      admin: 1
    },
    missingSources: ["nginx_error"],
    loadedAt: 1710000000000
  });

  assert.equal(payload.source, "all");
  assert.equal(payload.requestedSource, "all");
  assert.equal(payload.requestedLimit, 500);
  assert.equal(payload.lineCount, 2);
  assert.deepEqual(payload.files, {
    backend: "/tmp/backend.log",
    nginx_access: "/tmp/access.log",
    nginx_error: "/tmp/error.log",
    admin: "adminLogBuffer"
  });
  assert.equal(payload.sourceDetails.length, 4);
  assert.equal(payload.sourceDetails.find((item) => item.key === "backend")?.label, "llm-backend");
  assert.equal(payload.sourceDetails.find((item) => item.key === "nginx_error")?.missing, true);
  assert.deepEqual(payload.missingSources, ["nginx_error"]);
});

test("admin 后台缓存日志会被格式化成可读单行文本", () => {
  const line = formatAdminBufferLine({
    id: "log-1",
    level: "warning",
    message: "发布脚本版本",
    extra: { actor: "admin", releaseId: "rel_1" },
    createdAt: 1710000000000
  });

  assert.match(line, /^\[admin:warning\] /);
  assert.match(line, /发布脚本版本/);
  assert.match(line, /"releaseId":"rel_1"/);
});

test("script_history 契约可输出 pending / promote / rollback 时间线", () => {
  const list = buildScriptHistoryEntries({
    scriptName: "zf_parser.js",
    releaseRows: [
      {
        release_id: "rel_pending",
        version: 4,
        release_stage: "pending",
        parent_version: 3,
        issue_id: "issue_1",
        school_id: "school_a",
        school_name: "测试大学",
        changelog: "等待人工确认",
        created_at: "2026-05-23T09:00:00.000Z",
        created_by: "repair-bot"
      },
      {
        release_id: "rel_seed",
        version: 1,
        release_stage: "active",
        parent_version: 0,
        issue_id: "",
        school_id: "",
        school_name: "",
        changelog: "初始版本",
        created_at: "2026-05-20T09:00:00.000Z",
        created_by: "seed"
      }
    ],
    auditRows: [
      {
        action: "publish_release",
        actor: "admin",
        detail_stage: "active",
        release_id: "rel_pending",
        version: 4,
        parent_version: 3,
        release_stage: "active",
        issue_id: "issue_1",
        school_id: "school_a",
        school_name: "测试大学",
        audit_created_at: "2026-05-23T10:00:00.000Z"
      },
      {
        action: "rollback_release",
        actor: "admin",
        detail_parent_release_id: "rel_prev",
        release_id: "rel_pending",
        version: 4,
        parent_version: 3,
        release_stage: "rolled_back",
        issue_id: "issue_1",
        school_id: "school_a",
        school_name: "测试大学",
        audit_created_at: "2026-05-23T11:00:00.000Z"
      }
    ],
    limit: 10
  });

  assert.equal(list.length, 4);
  assert.equal(list[0].type, "rollback_admin");
  assert.equal(list[1].type, "promote_active");
  assert.equal(list[2].type, "pending");
  assert.equal(list[3].type, "apply");
  assert.equal(list[1].meta.version, 4);
  assert.equal(list[2].meta.parentVersion, 3);
  assert.deepEqual(list[2].context.issueIds, ["issue_1"]);
  assert.equal(list[2].schoolId, "school_a");
});
