import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "../dist/classifier.js";

test("正方教务门户未进入课表页时归类为导航失败", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "ZF",
      sourceUrl: "https://jw.tskjxy.edu.cn/jwglxt/xtgl/mmgl_xgRsaMm.html"
    },
    pageFingerprint: {
      host: "jw.tskjxy.edu.cn",
      pathPattern: "/jwglxt/xtgl/mmgl_xgRsaMm.html",
      hasCourseKeyword: false,
      hasLoginKeyword: false,
      hasCaptcha: false
    },
    attempts: [],
    finalFailureType: "parser_empty"
  });

  assert.equal(result.repairDomain, "NAVIGATION_FAILURE");
  assert.equal(result.targetType, "navigation");
  assert.equal(result.scriptName, "zf_nav.js");
  assert.equal(result.failureType, "navigation_failure");
  assert.equal(result.shouldAutoRepair, true);
});

test("明显无关页面仍保持为非课表页", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "UNKNOWN",
      sourceUrl: "https://example.com/help/about.html"
    },
    pageFingerprint: {
      host: "example.com",
      pathPattern: "/help/about.html",
      hasCourseKeyword: false,
      hasLoginKeyword: false,
      hasCaptcha: false
    },
    attempts: [],
    finalFailureType: "parser_empty"
  });

  assert.equal(result.repairDomain, "NON_TIMETABLE_PAGE");
  assert.equal(result.targetType, "none");
  assert.equal(result.scriptName, "none");
  assert.equal(result.shouldAutoRepair, false);
});

test("登录和验证码页面不进入自动修复", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "ZF",
      sourceUrl: "https://jw.example.edu.cn/login"
    },
    pageFingerprint: {
      host: "jw.example.edu.cn",
      pathPattern: "/login",
      hasCourseKeyword: false,
      hasLoginKeyword: true,
      hasCaptcha: true
    },
    attempts: [],
    finalFailureType: "验证码页面，用户未登录"
  });

  assert.equal(result.repairDomain, "LOGIN_OR_CAPTCHA");
  assert.equal(result.targetType, "none");
  assert.equal(result.shouldAutoRepair, false);
});

test("学年学期选项为空时归类为学期提取脚本修复", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "ZF",
      sourceUrl: "https://jw.example.edu.cn/jwglxt/xtgl/index_initMenu.html"
    },
    pageFingerprint: {
      host: "jw.example.edu.cn",
      pathPattern: "/jwglxt/xtgl/index_initMenu.html",
      hasCourseKeyword: false,
      hasLoginKeyword: false,
      hasCaptcha: false
    },
    attempts: [],
    finalFailureType: "学年学期选项持续为空，转入解析失败流程"
  });

  assert.equal(result.repairDomain, "TERM_EXTRACT_FAILURE");
  assert.equal(result.targetType, "term_extractor");
  assert.equal(result.scriptName, "auto_sync_extractor.js");
  assert.equal(result.shouldAutoRepair, true);
});

test("课表页 parser 空结果归类为 parser 修复", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "ZF",
      sourceUrl: "https://jw.example.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html"
    },
    pageFingerprint: {
      host: "jw.example.edu.cn",
      pathPattern: "/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html",
      hasCourseKeyword: true,
      hasLoginKeyword: false,
      hasCaptcha: false
    },
    attempts: [{ parserName: "zhengfang.js", parserVersion: 1, failureType: "parser_empty" }],
    finalFailureType: "parser_empty",
    sanitizedContent: "<table id=\"kbtable\"><tr><td>星期一</td><td>课程</td></tr></table>"
  });

  assert.equal(result.repairDomain, "PARSER_FAILURE");
  assert.equal(result.targetType, "parser");
  assert.equal(result.scriptName, "zhengfang.js");
  assert.equal(result.shouldAutoRepair, true);
});
