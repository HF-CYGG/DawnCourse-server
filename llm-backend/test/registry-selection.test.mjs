import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScriptReleaseScopeForTest,
  categoryFromDir,
  selectManifestRowsForTest,
  targetTypeFor
} from "../dist/registry.js";

test("脚本分类按目录名推断，runtime 不被误判为解析器", () => {
  // 旧实现是「以 /js 结尾则 js，否则一律 parsers」，新增 runtime 目录后
  // 会把共享执行契约当成课表解析脚本入库并参与优先级排序。
  assert.equal(categoryFromDir("/shared/scripts/parsers"), "parsers");
  assert.equal(categoryFromDir("/shared/scripts/js"), "js");
  assert.equal(categoryFromDir("/shared/scripts/runtime"), "runtime");
  assert.equal(categoryFromDir("C:\\shared\\scripts\\runtime\\"), "runtime");
  assert.equal(categoryFromDir("/shared/scripts/unknown"), "parsers");

  assert.equal(targetTypeFor("parsers", "zhengfang.js"), "parser");
  assert.equal(targetTypeFor("runtime", "script_host.js"), "runtime");
  assert.equal(targetTypeFor("js", "zf_nav.js"), "navigation");
});

function release(overrides) {
  return {
    release_id: "rel-active",
    script_id: "parser.zhengfang",
    target_type: "parser",
    category: "parsers",
    name: "zhengfang.js",
    version: 1,
    release_stage: "active",
    channel: "stable",
    status: "enabled",
    rollout_percent: 100,
    kill_switch: false,
    min_app_version_code: "0",
    max_app_version_code: null,
    school_system_types_json: ["ZF"],
    school_ids_json: [],
    changelog: "",
    content_sha256: "hash",
    signature: "sig",
    alg: "rsa-sha256",
    school_binding_id: null,
    selection_policy: "auto",
    ...overrides
  };
}

test("manifest selection prefers user fixed release over school binding and canary", () => {
  const selected = selectManifestRowsForTest(
    [
      release({ release_id: "rel-active", version: 1 }),
      release({ release_id: "rel-canary", version: 2, release_stage: "canary", rollout_percent: 100 }),
      release({ release_id: "rel-school", version: 3, school_ids_json: ["tskjxy"], school_binding_id: "bind-1" }),
      release({ release_id: "rel-fixed", version: 4 })
    ],
    {
      systemType: "ZF",
      schoolId: "tskjxy",
      appVersionCode: 100,
      bucket: "bucket-a",
      selection: {
        selection_policy: "fixed_release",
        preferred_release_id: "rel-fixed",
        preferred_script_id: null
      },
      bindings: []
    }
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].release_id, "rel-fixed");
  assert.equal(selected[0].selection_policy, "fixed_release");
});

test("manifest selection prefers school binding before global active", () => {
  const selected = selectManifestRowsForTest(
    [
      release({ release_id: "rel-global", version: 1, school_ids_json: [] }),
      release({ release_id: "rel-school", version: 2, school_ids_json: ["tskjxy"], school_binding_id: "bind-1" })
    ],
    {
      systemType: "ZF",
      schoolId: "tskjxy",
      appVersionCode: 100,
      bucket: "bucket-a",
      selection: null,
      bindings: [
        {
          binding_id: "bind-1",
          release_id: "rel-school",
          script_id: "parser.zhengfang",
          selection_policy: "school_specific",
          priority: 10
        }
      ]
    }
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].release_id, "rel-school");
  assert.equal(selected[0].school_binding_id, "bind-1");
  assert.equal(selected[0].selection_policy, "school_binding");
});

test("manifest selection returns canary before active when rollout hits", () => {
  const selected = selectManifestRowsForTest(
    [
      release({ release_id: "rel-active", version: 1, release_stage: "active", rollout_percent: 100 }),
      release({ release_id: "rel-canary", version: 2, release_stage: "canary", rollout_percent: 100 })
    ],
    {
      systemType: "ZF",
      schoolId: "tskjxy",
      appVersionCode: 100,
      bucket: "bucket-a",
      selection: null,
      bindings: []
    }
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].release_id, "rel-canary");
  assert.equal(selected[0].release_stage, "canary");
});

test("pending school-specific script release is scoped to the unmatched school", () => {
  const scope = buildScriptReleaseScopeForTest({
    name: "zhengfang.js",
    schoolId: "school:zf:泰山科技学院",
    schoolSystemType: "ZF"
  });

  assert.deepEqual(scope.schoolSystemTypes, ["ZF"]);
  assert.deepEqual(scope.schoolIds, ["school:zf:泰山科技学院"]);
});
