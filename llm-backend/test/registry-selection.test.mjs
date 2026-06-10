import assert from "node:assert/strict";
import test from "node:test";
import { selectManifestRowsForTest } from "../dist/registry.js";

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
