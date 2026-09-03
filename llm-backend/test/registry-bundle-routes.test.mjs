/**
 * 文件说明：验证不可变脚本 bundle 与匿名激活聚合路由。
 */

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRegistryRoutes } from "../dist/registry.js";

test("bundle 路由按 releaseId 返回固定脚本与依赖", async () => {
  const app = Fastify();
  await registerRegistryRoutes(app, {
    query: async (sql) => {
      if (sql.includes("FROM script_releases r") && sql.includes("bundle_release")) {
        return {
          rowCount: 1,
          rows: [{
            release_id: "rel-main",
            script_key: "parser/parsers/zhengfang.js/system/ZF",
            target_type: "parser",
            category: "parsers",
            name: "zhengfang.js",
            version: 2,
            scope_kind: "system",
            scope_id: "ZF",
            school_system_type: "ZF",
            parser_api_version: 1,
            runner_contract_version: 1,
            content: "function parse() { return []; }",
            content_sha256: "main-hash",
            signature: "main-signature",
            alg: "rsa-sha256"
          }]
        };
      }
      if (sql.includes("FROM script_release_dependencies")) {
        return {
          rowCount: 1,
          rows: [{
            dependency_release_id: "rel-utils",
            category: "parsers",
            name: "common_parser_utils.js",
            version: 3,
            content: "globalThis.utils = {};",
            content_sha256: "dependency-hash",
            signature: "dependency-signature",
            alg: "rsa-sha256"
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    },
    signContent: () => "bundle-signature"
  });

  const response = await app.inject({ method: "GET", url: "/api/v1/scripts/releases/rel-main/bundle" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.releaseId, "rel-main");
  assert.equal(body.script.content, "function parse() { return []; }");
  assert.equal(body.dependencies[0].releaseId, "rel-utils");
  assert.equal(body.bundleSignature, "bundle-signature");
  await app.close();
});

test("激活事件只写入聚合维度且拒绝未知事件", async () => {
  const calls = [];
  const app = Fastify();
  await registerRegistryRoutes(app, {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("activation_release")) {
        return {
          rowCount: 1,
          rows: [{
            release_id: "rel-main",
            target_type: "parser",
            category: "parsers",
            name: "zhengfang.js",
            school_system_types_json: ["ZF"],
            school_ids_json: ["school-a"]
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    }
  });

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/scripts/activation-events",
    payload: {
      releaseId: "rel-main",
      schoolId: "school-a",
      schoolSystemType: "ZF",
      eventType: "activated",
      errorCode: ""
    }
  });
  assert.equal(accepted.statusCode, 202);
  const aggregateCall = calls.find((item) => item.sql.includes("INSERT INTO script_activation_metrics"));
  assert.deepEqual(aggregateCall.params, ["rel-main", "school-a", "ZF", "activated", ""]);

  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/scripts/activation-events",
    payload: { releaseId: "rel-main", eventType: "device_detail" }
  });
  assert.equal(rejected.statusCode, 400);
  await app.close();
});
