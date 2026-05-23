/**
 * 文件说明：验证修复脚本工作流分类。
 * 重点防止“手动网页抓取脚本”和“自动测试链路脚本”再次被混在同一语义下展示或处理。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeScriptRepairWorkflow,
  formatScriptRepairWorkflowLabel,
  resolveScriptRepairWorkflow
} from "../dist/repairWorkflow.js";

test("parser 类型归类为手动网页抓取脚本", () => {
  const workflow = resolveScriptRepairWorkflow({
    repairDomain: "PARSER_FAILURE",
    targetType: "parser",
    category: "parsers"
  });
  assert.equal(workflow, "manual_capture");
  assert.equal(formatScriptRepairWorkflowLabel(workflow), "手动网页抓取脚本");
  assert.match(describeScriptRepairWorkflow(workflow), /固定页面/);
});

test("navigation 与 term_extractor 归类为自动测试链路脚本", () => {
  assert.equal(
    resolveScriptRepairWorkflow({
      repairDomain: "NAVIGATION_FAILURE",
      targetType: "navigation",
      category: "js"
    }),
    "auto_flow"
  );
  assert.equal(
    resolveScriptRepairWorkflow({
      repairDomain: "TERM_EXTRACT_FAILURE",
      targetType: "term_extractor",
      category: "js"
    }),
    "auto_flow"
  );
});

test("none 与非自动修复问题归类为不进入脚本修复", () => {
  const workflow = resolveScriptRepairWorkflow({
    repairDomain: "NON_TIMETABLE_PAGE",
    targetType: "none",
    category: "none"
  });
  assert.equal(workflow, "not_applicable");
  assert.equal(formatScriptRepairWorkflowLabel(workflow), "不进入脚本修复");
});
