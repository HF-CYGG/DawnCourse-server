import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createRunnerServer, normalizeResultForTest } from "../../script-runner/runner.js";

test("runner rejects parser courses without courseName", () => {
  const result = normalizeResultForTest("parser", [
    { dayOfWeek: 1, startSection: 1, duration: 2, startWeek: 1, endWeek: 16 }
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("runner rejects term extractor results without label and value", () => {
  const result = normalizeResultForTest("term_extractor", [{ label: "2025-2026" }]);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("runner rejects navigation results without action and target", () => {
  const result = normalizeResultForTest("navigation", { foo: "bar" });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("runner blocks Node host globals from generated scripts", async () => {
  const server = createRunnerServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await postJson(address.port, {
      targetType: "parser",
      sampleContent: "<html></html>",
      timeoutMs: 3000,
      scriptContent: `
        function scheduleHtmlParser() {
          if (typeof process !== "undefined") throw new Error("process exposed");
          if (typeof require !== "undefined") throw new Error("require exposed");
          if (typeof Buffer !== "undefined") throw new Error("buffer exposed");
          const host = Function("return this")();
          if (host && (host.process || host.Buffer)) throw new Error("host global exposed");
          // 字段名必须是 name：设备端 parseParsedCourseArray 只读 name，
          // 沙箱若接受 courseName 等别名，会放行「服务端通过但设备端 0 门课」的脚本。
          return [{ name: "安全测试", dayOfWeek: 1, startSection: 1, duration: 2, startWeek: 1, endWeek: 16 }];
        }
      `
    });

    assert.equal(response.ok, true);
    assert.equal(response.schemaValid, true);
    assert.equal(response.resultCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function postJson(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/run",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}
