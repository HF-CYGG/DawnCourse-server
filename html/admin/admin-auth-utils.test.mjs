import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStoredAdminToken, resolveAdminApiError } from "./admin-auth-utils.js";

test("normalizeStoredAdminToken 会过滤占位 token 并保留有效值", () => {
  assert.equal(normalizeStoredAdminToken(""), "");
  assert.equal(normalizeStoredAdminToken("   "), "");
  assert.equal(normalizeStoredAdminToken("undefined"), "");
  assert.equal(normalizeStoredAdminToken("null"), "");
  assert.equal(normalizeStoredAdminToken("  dawn-token  "), "dawn-token");
});

test("resolveAdminApiError 能识别 HTTP 200 下的未授权业务错误", () => {
  const result = resolveAdminApiError(200, {
    code: 401,
    msg: "账号或密码错误",
    data: null
  });
  assert.deepEqual(result, {
    kind: "unauthorized",
    message: "账号或密码错误"
  });
});

test("resolveAdminApiError 对成功响应返回 null", () => {
  const result = resolveAdminApiError(200, {
    code: 200,
    msg: "ok",
    data: { token: "adm-token" }
  });
  assert.equal(result, null);
});
