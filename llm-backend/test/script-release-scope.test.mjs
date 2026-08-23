/**
 * 文件说明：脚本发布作用域与不可变 bundle 的契约测试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildImmutableBundlePayload,
  buildScriptKey,
  deriveReleaseScope,
  releaseScopeMatchesRequest,
  sameScriptTrack
} from "../dist/scriptRelease.js";

test("学校发布只匹配同一非空学校", () => {
  const scope = deriveReleaseScope({
    targetType: "parser",
    category: "parsers",
    name: "zhengfang.js",
    schoolSystemTypes: ["ZF"],
    schoolIds: ["school-a"]
  });

  assert.equal(releaseScopeMatchesRequest(scope, "ZF", "school-a"), true);
  assert.equal(releaseScopeMatchesRequest(scope, "ZF", "school-b"), false);
  assert.equal(releaseScopeMatchesRequest(scope, "ZF", ""), false);
});

test("系统通用发布与学校发布形成不同发布轨道", () => {
  const systemScope = deriveReleaseScope({
    targetType: "parser",
    category: "parsers",
    name: "zhengfang.js",
    schoolSystemTypes: ["ZF"],
    schoolIds: []
  });
  const schoolScope = deriveReleaseScope({
    targetType: "parser",
    category: "parsers",
    name: "zhengfang.js",
    schoolSystemTypes: ["ZF"],
    schoolIds: ["school-a"]
  });

  assert.equal(buildScriptKey(systemScope), "parser/parsers/zhengfang.js/system/ZF");
  assert.equal(buildScriptKey(schoolScope), "parser/parsers/zhengfang.js/school/school-a");
  assert.equal(sameScriptTrack(systemScope, schoolScope), false);
  assert.equal(sameScriptTrack(schoolScope, { ...schoolScope }), true);
});

test("不可变 bundle 固定主脚本和依赖 release", () => {
  const payload = buildImmutableBundlePayload({
    release: {
      releaseId: "rel-school",
      scriptKey: "parser/parsers/zhengfang.js/school/school-a",
      targetType: "parser",
      category: "parsers",
      name: "zhengfang.js",
      version: 4,
      scopeKind: "school",
      scopeId: "school-a",
      schoolSystemType: "ZF",
      parserApiVersion: 1,
      runnerContractVersion: 1
    },
    artifact: {
      content: "function parse() { return []; }",
      sha256: "main-hash",
      signature: "main-signature",
      alg: "rsa-sha256"
    },
    dependencies: [
      {
        releaseId: "rel-utils",
        category: "parsers",
        name: "common_parser_utils.js",
        version: 3,
        content: "globalThis.utils = {};",
        sha256: "dependency-hash",
        signature: "dependency-signature",
        alg: "rsa-sha256"
      }
    ]
  });

  assert.equal(payload.releaseId, "rel-school");
  assert.equal(payload.script.sha256, "main-hash");
  assert.equal(payload.dependencies[0].releaseId, "rel-utils");
  assert.equal(payload.dependencies[0].version, 3);
  assert.equal(payload.dependencies[0].content, "globalThis.utils = {};");
});
