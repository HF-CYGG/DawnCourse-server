import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8090);
const MAX_BODY = Number(process.env.MAX_RUNNER_BODY || 1024 * 1024);

export function normalizeResultForTest(targetType, result) {
  return normalizeResult(targetType, result);
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
    : payload.targetType === "term_extractor"
      ? ["extractTermOptions", "run", "parse"]
      : ["navigateToSchedule", "detectPageState", "run", "parse"];
  if (payload.entry) names.unshift(payload.entry);
  for (const name of names) {
    if (typeof exported[name] === "function") return exported[name];
    if (typeof globalObject[name] === "function") return globalObject[name];
    if (typeof window[name] === "function") return window[name];
  }
  return null;
}
${normalizeResult.toString()}
${normalizeParserResult.toString()}
${normalizeTermExtractorResult.toString()}
${normalizeNavigationResult.toString()}
${toArray.toString()}
${isNonEmptyString.toString()}
${isPositiveNumber.toString()}
${isValidDay.toString()}
${hasValidWeeks.toString()}
${duplicateRatio.toString()}
${failure.toString()}
`;
}

function normalizeResult(targetType, result) {
  if (targetType === "parser") return normalizeParserResult(result);
  if (targetType === "term_extractor") return normalizeTermExtractorResult(result);
  if (targetType === "navigation") return normalizeNavigationResult(result);
  if (result == null) return failure("empty_result", "script returned empty result");
  const count = Array.isArray(result) ? result.length : Object.keys(Object(result)).length;
  return count > 0
    ? { ok: true, schemaValid: true, resultCount: count, errorCode: "", errorMessage: "" }
    : failure("empty_result", "empty structured result");
}

function normalizeParserResult(result) {
  const courses = Array.isArray(result) ? result : Array.isArray(result?.courses) ? result.courses : [];
  if (!courses.length) return failure("empty_result", "parser returned empty courses", true);
  const invalid = courses.find((course) => {
    const day = Number(course?.dayOfWeek ?? course?.day ?? course?.weekday);
    const start = Number(course?.startSection ?? course?.startNode ?? course?.sectionStart);
    const duration = Number(course?.duration ?? course?.step);
    return !isNonEmptyString(course?.courseName ?? course?.name ?? course?.title)
      || !isValidDay(day)
      || !isPositiveNumber(start)
      || !isPositiveNumber(duration)
      || !hasValidWeeks(course);
  });
  if (invalid) return failure("schema_invalid", "course schema invalid");
  if (duplicateRatio(courses) > 0.2) return failure("duplicate_ratio_high", "duplicate course ratio is too high");
  return { ok: true, schemaValid: true, resultCount: courses.length, errorCode: "", errorMessage: "" };
}

function normalizeTermExtractorResult(result) {
  const options = toArray(result?.terms ?? result?.options ?? result);
  if (!options.length) return failure("empty_result", "term extractor returned empty options");
  const validCount = options.filter((option) => {
    const label = String(option?.label ?? option?.name ?? "");
    const value = String(option?.value ?? option?.id ?? option?.termId ?? "");
    return isNonEmptyString(label) && isNonEmptyString(value) && /\\d{4}|semester|term/i.test(`${label} ${value}`);
  }).length;
  return validCount > 0
    ? { ok: true, schemaValid: true, resultCount: options.length, errorCode: "", errorMessage: "" }
    : failure("schema_invalid", "term option schema invalid");
}

function normalizeNavigationResult(result) {
  if (!result || typeof result !== "object") return failure("empty_result", "navigation returned empty result");
  const action = String(result.action ?? result.type ?? result.kind ?? "");
  const target = String(result.url ?? result.targetUrl ?? result.path ?? result.menuPath ?? result.selector ?? "");
  const lowerTarget = target.toLowerCase();
  const validAction = /navigate|click|open|redirect|state|menu|detect/i.test(action);
  const validTarget = isNonEmptyString(target)
    && (lowerTarget.startsWith("http://")
      || lowerTarget.startsWith("https://")
      || target.startsWith("/")
      || lowerTarget.includes("xskb")
      || lowerTarget.includes("schedule")
      || lowerTarget.includes("timetable"));
  return validAction && validTarget
    ? { ok: true, schemaValid: true, resultCount: 1, errorCode: "", errorMessage: "" }
    : failure("schema_invalid", "navigation action or target invalid");
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return String(value ?? "").trim().length > 0;
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function isValidDay(value) {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

function hasValidWeeks(course) {
  const start = Number(course?.startWeek ?? course?.weekStart ?? course?.start ?? 1);
  const end = Number(course?.endWeek ?? course?.weekEnd ?? course?.end ?? start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start > 0 && end >= start && end <= 60;
}

function duplicateRatio(courses) {
  if (courses.length <= 1) return 0;
  const keys = courses.map((course) =>
    [
      course?.courseName ?? course?.name ?? "",
      course?.dayOfWeek ?? course?.day ?? "",
      course?.startSection ?? course?.startNode ?? "",
      course?.startWeek ?? "",
      course?.endWeek ?? ""
    ].join("|")
  );
  return 1 - new Set(keys).size / keys.length;
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
