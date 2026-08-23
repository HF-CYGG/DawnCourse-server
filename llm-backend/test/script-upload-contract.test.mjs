import test from "node:test";
import assert from "node:assert/strict";
import { validateScriptUploadInput } from "../dist/scriptUpload.js";

const parserInput = {
  name: "zhengfang.js",
  category: "parsers",
  targetType: "parser",
  scopeKind: "system",
  scopeId: "ZF",
  schoolSystemType: "ZF",
  content: "function parse() { return []; }",
  changelog: "test"
};

test("parser upload accepts a scoped UTF-8 JavaScript candidate", () => {
  assert.deepEqual(validateScriptUploadInput(parserInput), { ok: true, error: "" });
});

test("runtime and oversized uploads are rejected", () => {
  assert.equal(validateScriptUploadInput({ ...parserInput, category: "runtime" }).error, "runtime_upload_forbidden");
  assert.equal(
    validateScriptUploadInput({ ...parserInput, content: "x".repeat(256 * 1024 + 1) }).error,
    "script_too_large"
  );
});

test("school uploads require a non-empty school id", () => {
  assert.equal(
    validateScriptUploadInput({ ...parserInput, scopeKind: "school", scopeId: "" }).error,
    "school_scope_id_required"
  );
});

test("WebView scripts require an explicit passed manual validation", () => {
  const webScript = {
    ...parserInput,
    category: "js",
    targetType: "navigation",
    name: "zf_autofill.js",
    testSchoolId: "school-a",
    pageStage: "login",
    manualValidationResult: "账号密码填充成功",
    manualValidationPassed: true
  };
  assert.deepEqual(validateScriptUploadInput(webScript), { ok: true, error: "" });
  assert.equal(validateScriptUploadInput({ ...webScript, manualValidationPassed: false }).error, "manual_validation_required");
});
