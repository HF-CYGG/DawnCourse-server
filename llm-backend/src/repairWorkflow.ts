/**
 * 文件说明：统一定义修复脚本工作流分类。
 * 用于区分“手动网页抓取后的固定页面解析脚本”和“自动登录/跳转/识别链路脚本”，
 * 避免后台页面、修复提示词和发布语义继续把两条链路混在一起。
 */

import { RepairDomain, TargetType } from "./types.js";

/**
 * 修复脚本工作流：
 * - manual_capture：手动网页抓取后的固定页面课表解析；
 * - auto_flow：自动登录、页面跳转、学期提取、课表识别等自动链路；
 * - not_applicable：当前问题不进入脚本修复。
 */
export type ScriptRepairWorkflow = "manual_capture" | "auto_flow" | "not_applicable";

export function resolveScriptRepairWorkflow(input: {
  repairDomain?: RepairDomain | string;
  targetType?: TargetType | string;
  category?: string;
}): ScriptRepairWorkflow {
  const repairDomain = String(input.repairDomain || "").trim().toUpperCase();
  const targetType = String(input.targetType || "").trim().toLowerCase();
  const category = String(input.category || "").trim().toLowerCase();

  if (targetType === "none" || repairDomain === "LOGIN_OR_CAPTCHA" || repairDomain === "NON_TIMETABLE_PAGE") {
    return "not_applicable";
  }
  if (targetType === "parser") {
    return "manual_capture";
  }
  if (targetType === "navigation" || targetType === "term_extractor" || targetType === "cloud_parse" || category === "js") {
    return "auto_flow";
  }
  return "manual_capture";
}

export function formatScriptRepairWorkflowLabel(workflow: ScriptRepairWorkflow): string {
  if (workflow === "manual_capture") return "手动网页抓取脚本";
  if (workflow === "auto_flow") return "自动测试链路脚本";
  return "不进入脚本修复";
}

export function describeScriptRepairWorkflow(workflow: ScriptRepairWorkflow): string {
  if (workflow === "manual_capture") {
    return "仅针对固定页面中的课表内容做识别与提取，不负责自动登录和页面跳转。";
  }
  if (workflow === "auto_flow") {
    return "负责自动登录、页面跳转、学期定位、课表识别与提取的完整自动测试链路。";
  }
  return "当前问题不进入脚本自动修复与发布链路。";
}
