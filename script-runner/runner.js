import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8090);
const MAX_BODY = Number(process.env.MAX_RUNNER_BODY || 1024 * 1024);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { ok: false, errorMessage: "not_found" });
    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const result = await execute(payload);
    return send(res, 200, result);
  } catch (error) {
    return send(res, 500, {
      ok: false,
      status: "failed",
      durationMs: 0,
      schemaValid: false,
      resultCount: 0,
      errorCode: "runner_server_error",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[runner] listening on ${PORT}`);
});

function execute(payload) {
  const timeoutMs = Math.max(500, Math.min(Number(payload.timeoutMs || 5000), 60000));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", childProgram()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "" }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        status: "timeout",
        durationMs: Date.now() - started,
        schemaValid: false,
        resultCount: 0,
        console: [],
        errorCode: "timeout",
        errorMessage: "script execution timed out"
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout || "{}");
        resolve({ ...json, durationMs: Date.now() - started });
      } catch {
        resolve({
          ok: false,
          status: "failed",
          durationMs: Date.now() - started,
          schemaValid: false,
          resultCount: 0,
          console: [],
          errorCode: "invalid_runner_output",
          errorMessage: stderr.slice(0, 1000) || stdout.slice(0, 1000)
        });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function childProgram() {
  return `
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  const started = Date.now();
  const logs = [];
  const payload = JSON.parse(input || "{}");
  const console = { log: (...args) => logs.push(args.map(String).join(" ")), warn: (...args) => logs.push(args.map(String).join(" ")), error: (...args) => logs.push(args.map(String).join(" ")) };
  const window = {};
  const document = undefined;
  const fetch = undefined;
  const XMLHttpRequest = undefined;
  try {
    const exported = {};
    for (const dep of payload.dependencies || []) {
      Object.assign(exported, executeSource(String(dep.content || ""), console, window, document, fetch, XMLHttpRequest));
    }
    Object.assign(exported, executeSource(String(payload.scriptContent || ""), console, window, document, fetch, XMLHttpRequest));
    const fn = resolveEntry(payload, window, globalThis, exported);
    if (typeof fn !== "function") throw new Error("entry_not_found");
    const result = fn(String(payload.sampleContent || ""));
    const normalized = normalizeResult(payload.targetType, result);
    process.stdout.write(JSON.stringify({ ok: normalized.ok, status: normalized.ok ? "passed" : "invalid", schemaValid: normalized.schemaValid, resultCount: normalized.resultCount, result, console: logs, durationMs: Date.now() - started, errorCode: normalized.errorCode, errorMessage: normalized.errorMessage }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, status: "failed", schemaValid: false, resultCount: 0, console: logs, durationMs: Date.now() - started, errorCode: "script_exception", errorMessage: error && error.message ? error.message : String(error) }));
  }
});
function executeSource(source, console, window, document, fetch, XMLHttpRequest) {
  const names = ["scheduleHtmlParser", "scheduleHtmlProvider", "scheduleTimer", "parse", "extractTermOptions", "detectPageState", "navigateToSchedule", "run"];
  const capture = "return {" + names.map(name => name + ": (typeof " + name + " !== 'undefined' ? " + name + " : window." + name + ")").join(",") + "};";
  return Function("console","window","document","fetch","XMLHttpRequest", source + "\\n" + capture)(console, window, document, fetch, XMLHttpRequest) || {};
}
function resolveEntry(payload, window, globalObject, exported) {
  const names = payload.targetType === "parser"
    ? ["scheduleHtmlParser", "parse", "scheduleHtmlProvider"]
    : ["extractTermOptions", "detectPageState", "navigateToSchedule", "run", "parse"];
  if (payload.entry) names.unshift(payload.entry);
  for (const name of names) {
    if (typeof exported[name] === "function") return exported[name];
    if (typeof globalObject[name] === "function") return globalObject[name];
    if (typeof window[name] === "function") return window[name];
  }
  return null;
}
function normalizeResult(targetType, result) {
  if (targetType === "parser") {
    const arr = Array.isArray(result) ? result : Array.isArray(result && result.courses) ? result.courses : [];
    if (!arr.length) return { ok: false, schemaValid: true, resultCount: 0, errorCode: "empty_result", errorMessage: "parser returned empty courses" };
    const valid = arr.some(c => c && Number(c.dayOfWeek || c.day || c.weekday) >= 1 && Number(c.startSection || c.startNode || c.sectionStart) > 0 && Number(c.duration || c.step || 1) > 0);
    return { ok: valid, schemaValid: valid, resultCount: arr.length, errorCode: valid ? "" : "schema_invalid", errorMessage: valid ? "" : "course schema invalid" };
  }
  if (result == null) return { ok: false, schemaValid: false, resultCount: 0, errorCode: "empty_result", errorMessage: "script returned empty result" };
  const count = Array.isArray(result) ? result.length : Object.keys(Object(result)).length;
  return { ok: count > 0, schemaValid: count > 0, resultCount: count, errorCode: count > 0 ? "" : "empty_result", errorMessage: count > 0 ? "" : "empty structured result" };
}
`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
