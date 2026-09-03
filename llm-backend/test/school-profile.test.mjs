import assert from "node:assert/strict";
import test from "node:test";
import { buildSchoolProfileUpsertForTest } from "../dist/collector.js";

test("unmatched school uses user-provided school name as stable school id", () => {
  const profile = buildSchoolProfileUpsertForTest({
    schoolId: "",
    schoolName: "泰山科技学院",
    schoolSystemType: "ZF",
    sourceUrl: "https://jw.tskjxy.edu.cn/jwglxt/kbcx/xskbcx_cxXsgrkb.html",
    issueId: "issue-1"
  });

  assert.equal(profile.schoolId, "school:zf:泰山科技学院");
  assert.equal(profile.schoolName, "泰山科技学院");
  assert.equal(profile.schoolSystemType, "ZF");
  assert.deepEqual(profile.sourceHosts, ["jw.tskjxy.edu.cn"]);
  assert.equal(profile.status, "reported");
  assert.equal(profile.createdFromIssueId, "issue-1");
});

test("unmatched school falls back to source host when school name is missing", () => {
  const profile = buildSchoolProfileUpsertForTest({
    schoolId: "",
    schoolName: "",
    schoolSystemType: "UNKNOWN",
    sourceUrl: "https://jw.example.edu.cn/path",
    issueId: "issue-2"
  });

  assert.equal(profile.schoolId, "school:unknown:jw.example.edu.cn");
  assert.equal(profile.schoolName, "jw.example.edu.cn");
  assert.deepEqual(profile.sourceHosts, ["jw.example.edu.cn"]);
});
