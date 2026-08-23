/**
 * 脚本沙箱执行服务
 *
 * 职责：在隔离的子进程中执行候选脚本，并返回结构化的执行报告。
 *
 * 关键约束：入口探测、调用编排与结果校验一律交给共享执行契约
 * （server/html/scripts/runtime/script_host.js），不得在本文件内另行实现。
 * 此前本文件维护了一套独立的 resolveEntry/normalizeResult，与设备端 QuickJS 的
 * 契约不一致，导致「沙箱判定通过的修复脚本在设备上跑不通」。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8090);
const MAX_BODY = Number(process.env.MAX_RUNNER_BODY || 1024 * 1024);

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 共享执行契约的候选路径（按优先级）
 *
 * 请求体里的 harnessSource 优先级最高：后端会把「即将下发给客户端的那一版 harness」
 * 随请求传入，从而保证沙箱校验环境与设备端完全一致。以下路径仅作为独立部署与测试兜底。
 */
const HARNESS_PATH_CANDIDATES = [
  process.env.SCRIPT_HOST_PATH,
  path.resolve(RUNNER_DIR, "../html/scripts/runtime/script_host.js"),
  "/usr/share/nginx/html/scripts/runtime/script_host.js",
  "/shared/scripts/runtime/script_host.js"
].filter(Boolean);

let cachedHarness = null;

/** 读取本地兜底的 harness 源码（结果缓存，失败返回空串） */
function loadLocalHarness() {
  if (cachedHarness !== null) return cachedHarness;
  for (const candidate of HARNESS_PATH_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        cachedHarness = fs.readFileSync(candidate, "utf8");
        return cachedHarness;
      }
    } catch {
      // 忽略单个候选路径的读取失败，继续尝试下一个
    }
  }
  cachedHarness = "";
  return cachedHarness;
}

/** 解析本次请求实际使用的 harness 源码 */
function resolveHarness(payload) {
  const provided = String(payload?.harnessSource || "").trim();
  if (provided) return provided;
  return loadLocalHarness();
}

/**
 * 供测试与后端复用的结果校验入口
 *
 * 直接委托共享契约，保证「测试断言的口径」与「沙箱实际判定的口径」是同一份实现。
 */
export function normalizeResultForTest(targetType, result) {
  const harness = loadLocalHarness();
  if (!harness) {
    return failure("harness_missing", "shared script host contract is not available");
  }
  const scope = {};
  // 间接 eval：让 harness 安装到当前进程的全局对象上，与子进程内的装载方式保持一致
  const install = new Function("globalThis", `${harness}\nreturn globalThis.__dawnHost;`);
  const host = install(scope) || scope.__dawnHost;
  const inspection = host.inspectPayload(targetType, result);
  return {
    ok: inspection.schemaValid && inspection.resultCount > 0,
    schemaValid: inspection.schemaValid,
    resultCount: inspection.resultCount,
    errorCode: inspection.errorCode,
    errorMessage: inspection.errorMessage
  };
}

export function createRunnerServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
      if (req.method !== "POST" || req.url !== "/run") return send(res, 404, failure("not_found", "not_found"));
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
}

if (isMainModule()) {
  createRunnerServer().listen(PORT, "0.0.0.0", () => {
    console.log(`[runner] listening on ${PORT}`);
  });
}

function execute(payload) {
  const timeoutMs = Math.max(500, Math.min(Number(payload.timeoutMs || 5000), 60000));
  const started = Date.now();
  const harnessSource = resolveHarness(payload);
  if (!harnessSource) {
    return Promise.resolve({
      ok: false,
      status: "failed",
      durationMs: 0,
      schemaValid: false,
      resultCount: 0,
      console: [],
      errorCode: "harness_missing",
      errorMessage: "shared script host contract is not available"
    });
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", childProgram()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "" }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      // 子进程强杀是唯一能中断同步死循环的手段：
      // harness 的执行预算只能覆盖微任务层，同步死循环必须靠这里兜底。
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
    // harness 通过 stdin 随负载传入，避免拼接进子进程源码时被脚本内容破坏
    child.stdin.end(JSON.stringify({ ...payload, harnessSource }));
  });
}

function childProgram() {
  return `
let input = "";
const __stdout = process.stdout;
process.stdin.on("data", c => input += c);
process.stdin.on("end", async () => {
  const started = Date.now();
  const logs = [];
  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch (error) {
    __stdout.write(JSON.stringify({ ok: false, status: "failed", schemaValid: false, resultCount: 0, console: [], durationMs: 0, errorCode: "invalid_payload", errorMessage: "payload is not valid json" }));
    return;
  }
  const console = { log: (...args) => logs.push(args.map(String).join(" ")), warn: (...args) => logs.push(args.map(String).join(" ")), error: (...args) => logs.push(args.map(String).join(" ")) };
  const window = {};
  const document = undefined;
  const fetch = undefined;
  const XMLHttpRequest = undefined;
  try {
    // 先装载共享执行契约，再锁死宿主全局：harness 自身不依赖任何 Node 能力
    installHarness(String(payload.harnessSource || ""));
    lockDownHostGlobals();
    const host = globalThis.__dawnHost;
    if (!host) throw new Error("harness_not_installed");

    const exported = {};
    for (const dep of payload.dependencies || []) {
      Object.assign(exported, executeSource(String(dep.content || ""), console, window, document, fetch, XMLHttpRequest));
    }
    Object.assign(exported, executeSource(String(payload.scriptContent || ""), console, window, document, fetch, XMLHttpRequest));

    const options = {
      targetType: payload.targetType || "parser",
      entry: payload.entry || "",
      deadlineAt: Date.now() + Math.max(500, Number(payload.timeoutMs || 5000))
    };
    const pending = host.begin(exported, String(payload.sampleContent || ""), options);
    if (pending) {
      await host.settled();
    }
    if (!host.isSettled()) host.abortAsTimeout(options.entry);
    const outcome = host.result();
    __stdout.write(JSON.stringify({
      ok: outcome.ok,
      status: outcome.status,
      schemaValid: outcome.schemaValid,
      resultCount: outcome.resultCount,
      result: outcome.raw,
      entryUsed: outcome.entryUsed,
      contractVersion: outcome.contractVersion,
      console: logs,
      durationMs: Date.now() - started,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage
    }));
  } catch (error) {
    __stdout.write(JSON.stringify({ ok: false, status: "failed", schemaValid: false, resultCount: 0, console: logs, durationMs: Date.now() - started, errorCode: "script_exception", errorMessage: error && error.message ? error.message : String(error) }));
  }
});
function installHarness(source) {
  if (!source) throw new Error("harness_missing");
  // 间接 eval 保证 harness 安装到真实全局对象上，供后续 host.* 调用
  (0, eval)(source);
}
function executeSource(source, console, window, document, fetch, XMLHttpRequest) {
  const names = ["scheduleHtmlParser", "scheduleHtmlProvider", "scheduleTimer", "parse", "extractTermOptions", "detectPageState", "navigateToSchedule", "run"];
  const scriptGlobal = Object.create(null);
  const SafeFunction = function(sourceText) {
    if (String(sourceText || "").trim() === "return this") {
      return function() { return scriptGlobal; };
    }
    throw new Error("Function constructor is disabled in script runner");
  };
  const capture = "return {" + names.map(name => name + ": (typeof " + name + " !== 'undefined' ? " + name + " : (window." + name + " || globalThis." + name + "))").join(",") + "};";
  return Function(
    "console",
    "window",
    "document",
    "fetch",
    "XMLHttpRequest",
    "globalThis",
    "self",
    "process",
    "require",
    "module",
    "exports",
    "Buffer",
    "setTimeout",
    "setInterval",
    "WebAssembly",
    "Function",
    "\\\"use strict\\\";\\n" + source + "\\n" + capture
  )(console, window, document, fetch, XMLHttpRequest, scriptGlobal, scriptGlobal, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, SafeFunction) || {};
}
function lockDownHostGlobals() {
  for (const name of ["process", "require", "module", "exports", "Buffer", "SharedArrayBuffer", "WebAssembly"]) {
    try {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    } catch {
      try { globalThis[name] = undefined; } catch {}
    }
  }
}
`;
}

function failure(errorCode, errorMessage, schemaValid = false) {
  return { ok: false, schemaValid, resultCount: 0, errorCode, errorMessage };
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

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
