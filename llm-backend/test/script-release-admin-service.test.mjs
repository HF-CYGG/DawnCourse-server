/**
 * 文件说明：验证管理端脚本发布、回滚与停用只影响同一 scriptKey。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { disableScriptRelease, publishScriptRelease, rollbackScriptRelease } from "../dist/scriptReleaseAdminService.js";

function createDependencies(releaseOverrides = {}) {
  const statements = [];
  const release = {
    release_id: "rel-school",
    script_key: "parser/parsers/zhengfang.js/school/school-a",
    parent_release_id: "rel-parent",
    issue_id: "issue-a",
    validation_status: "passed",
    ...releaseOverrides
  };
  return {
    statements,
    deps: {
      query: async (sql) => ({ rowCount: 1, rows: [release] }),
      withTx: async (callback) => callback({
        query: async (sql, params = []) => {
          statements.push({ sql, params });
          if (sql.includes("parent_release")) {
            return { rowCount: 1, rows: [{ release_id: "rel-parent", script_key: release.script_key }] };
          }
          return { rowCount: 1, rows: [] };
        }
      })
    }
  };
}

test("全量发布只回滚同一 scriptKey 的 active", async () => {
  const fixture = createDependencies();
  await publishScriptRelease("rel-school", "active", 100, "admin", fixture.deps);

  const competingUpdate = fixture.statements.find((item) => item.sql.includes("release_stage = 'rolled_back'"));
  assert.match(competingUpdate.sql, /script_key = \$1/);
  assert.deepEqual(competingUpdate.params, ["parser/parsers/zhengfang.js/school/school-a", "rel-school"]);
});

test("灰度发布采用 1 到 99 的显式比例", async () => {
  const fixture = createDependencies();
  await publishScriptRelease("rel-school", "canary", 10, "admin", fixture.deps);

  const publishUpdate = fixture.statements.find((item) => item.sql.includes("approved_by"));
  assert.deepEqual(publishUpdate.params, ["rel-school", "canary", 10, "admin"]);
  await assert.rejects(() => publishScriptRelease("rel-school", "canary", 100, "admin", fixture.deps), /invalid_rollout_percent/);
});

test("未通过验证的候选不能发布", async () => {
  const fixture = createDependencies({ validation_status: "pending" });
  await assert.rejects(() => publishScriptRelease("rel-school", "active", 100, "admin", fixture.deps), /release_not_validated/);
  assert.equal(fixture.statements.length, 0);
});

test("回滚只恢复同一 scriptKey 的父版本", async () => {
  const fixture = createDependencies();
  await rollbackScriptRelease("rel-school", "admin", fixture.deps);

  const competingUpdate = fixture.statements.find(
    (item) => item.sql.includes("release_stage = 'rolled_back'") && item.params[0] === "parser/parsers/zhengfang.js/school/school-a"
  );
  assert.ok(competingUpdate);
  const parentActivation = fixture.statements.find((item) => item.sql.includes("release_stage = 'active'"));
  assert.deepEqual(parentActivation.params, ["rel-parent"]);
});

test("停用 release 会打开 kill switch 并写入审计", async () => {
  const fixture = createDependencies();
  await disableScriptRelease("rel-school", "线上异常", "admin", fixture.deps);

  const disabled = fixture.statements.find((item) => item.sql.includes("kill_switch = true"));
  assert.deepEqual(disabled.params, ["rel-school"]);
  const audit = fixture.statements.find((item) => item.sql.includes("disable_release"));
  assert.ok(audit);
});
