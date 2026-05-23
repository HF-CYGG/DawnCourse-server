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
