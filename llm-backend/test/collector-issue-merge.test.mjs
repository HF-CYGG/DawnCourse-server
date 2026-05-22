/**
 * 文件说明：验证同一 parseSession 的失败上报会优先复用既有 Repair Issue，避免单个用户一次提交被拆成多个问题。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveIssueReuse } from "../dist/collector.js";

test("同一 parseSession 已关联 issue 时优先复用 session issue", () => {
  const result = resolveIssueReuse({
    sessionIssueId: "issue-session",
    issueKeyIssueId: "issue-by-key"
  });

  assert.deepEqual(result, {
    issueId: "issue-session",
    reason: "parse_session"
  });
});

test("没有 session issue 时退回 issue_key 归并结果", () => {
  const result = resolveIssueReuse({
    sessionIssueId: "",
    issueKeyIssueId: "issue-by-key"
  });

  assert.deepEqual(result, {
    issueId: "issue-by-key",
    reason: "issue_key"
  });
});

test("既没有 session issue 也没有 issue_key 命中时返回 null", () => {
  const result = resolveIssueReuse({
    sessionIssueId: "",
    issueKeyIssueId: ""
  });

  assert.equal(result, null);
});
