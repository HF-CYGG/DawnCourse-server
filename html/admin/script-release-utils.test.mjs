import test from "node:test";
import assert from "node:assert/strict";
import {
  describeNonJsonAdminResponse,
  filterReleaseTracks,
  validateUploadFileDescriptor
} from "./script-release-utils.js";

const releases = [
  { schoolSystemType: "ZF", scopeKind: "system", category: "parsers", releaseStage: "active", validationStatus: "passed" },
  { schoolSystemType: "ZF", scopeKind: "school", category: "parsers", releaseStage: "pending", validationStatus: "passed" },
  { schoolSystemType: "QIANGZHI", scopeKind: "system", category: "js", releaseStage: "disabled", validationStatus: "failed" }
];

test("release track filters compose without fuzzy matching", () => {
  assert.equal(filterReleaseTracks(releases, { system: "ZF", scope: "school" }).length, 1);
  assert.equal(filterReleaseTracks(releases, { category: "parsers", stage: "active", validation: "passed" }).length, 1);
});

test("upload descriptor enforces js extension and 256 KiB", () => {
  assert.deepEqual(validateUploadFileDescriptor({ name: "school.js", size: 256 * 1024 }), { ok: true, error: "" });
  assert.equal(validateUploadFileDescriptor({ name: "school.txt", size: 10 }).error, "仅允许上传 .js 文件");
  assert.equal(validateUploadFileDescriptor({ name: "school.js", size: 256 * 1024 + 1 }).error, "文件不能超过 256 KiB");
});

test("static preview login failure is converted to an actionable message", () => {
  const html = '<!DOCTYPE HTML><html><body><p>Error code: 501</p><p>Message: Unsupported method (\'POST\').</p></body></html>';
  assert.equal(
    describeNonJsonAdminResponse(501, html, "text/html; charset=utf-8"),
    "当前地址是静态预览服务，不支持登录。请通过 Dawn Course 后端服务的 /admin/ 地址访问。"
  );
});

test("non-json admin responses never expose a raw html error page", () => {
  const message = describeNonJsonAdminResponse(502, "<html><body>upstream failed</body></html>", "text/html");
  assert.match(message, /返回了网页而不是 JSON/);
  assert.doesNotMatch(message, /<html>/);
});
