import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "../dist/classifier.js";

test("classifier exposes evidence and confidence for explicit term extraction failures", () => {
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
    attempts: [{ parserName: "auto_sync_extractor.js", category: "js", failureType: "term_options_empty" }],
    failureStage: "TERM_EXTRACT",
    finalFailureType: "term_options_empty"
  });

  assert.equal(result.repairDomain, "TERM_EXTRACT_FAILURE");
  assert.equal(result.targetType, "term_extractor");
  assert.equal(result.scriptName, "auto_sync_extractor.js");
  assert.equal(result.shouldAutoRepair, true);
  assert.equal(typeof result.confidence, "number");
  assert.ok(result.confidence >= 0.8);
  assert.ok(Array.isArray(result.evidence));
  assert.ok(result.evidence.some((item) => item.includes("failureStage=TERM_EXTRACT")));
});

test("cloud parse failures are diagnostic only unless a concrete repair target is identified", () => {
  const result = classifyFailure({
    session: {
      schoolSystemType: "ZF",
      sourceUrl: "https://jw.example.edu.cn/jwglxt/xtgl/mmgl_xgRsaMm.html"
    },
    pageFingerprint: {
      host: "jw.example.edu.cn",
      pathPattern: "/jwglxt/xtgl/mmgl_xgRsaMm.html",
      hasCourseKeyword: false,
      hasLoginKeyword: false,
      hasCaptcha: false
    },
    attempts: [{ parserName: "zhengfang.js", category: "parsers", failureType: "cloud_empty_result" }],
    failureStage: "CLOUD_PARSE",
    finalFailureType: "cloud_empty_result"
  });

  assert.equal(result.repairDomain, "CLOUD_PARSE_FAILURE");
  assert.equal(result.targetType, "cloud_parse");
  assert.equal(result.shouldAutoRepair, false);
  assert.ok(result.evidence.some((item) => item.includes("failureStage=CLOUD_PARSE")));
});
