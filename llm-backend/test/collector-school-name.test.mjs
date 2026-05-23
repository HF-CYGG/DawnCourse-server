/**
 * 文件说明：验证失败上报归并时学校名称的优先级，确保后台优先显示用户上传的真实学校名称。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreferredSchoolName } from "../dist/collector.js";

test("已有占位学校名为 host 时，后续真实学校名应覆盖", () => {
  const result = resolvePreferredSchoolName({
    currentSchoolName: "jw.tskjxy.edu.cn",
    incomingSchoolName: "泰山科技学院",
    schoolId: "jw.tskjxy.edu.cn",
    sourceHost: "jw.tskjxy.edu.cn"
  });

  assert.equal(result, "泰山科技学院");
});

test("已有真实学校名时，后续空值不应覆盖", () => {
  const result = resolvePreferredSchoolName({
    currentSchoolName: "泰山科技学院",
    incomingSchoolName: "",
    schoolId: "jw.tskjxy.edu.cn",
    sourceHost: "jw.tskjxy.edu.cn"
  });

  assert.equal(result, "泰山科技学院");
});

test("已有真实学校名时，后续回落成 host 不应覆盖", () => {
  const result = resolvePreferredSchoolName({
    currentSchoolName: "泰山科技学院",
    incomingSchoolName: "jw.tskjxy.edu.cn",
    schoolId: "jw.tskjxy.edu.cn",
    sourceHost: "jw.tskjxy.edu.cn"
  });

  assert.equal(result, "泰山科技学院");
});
