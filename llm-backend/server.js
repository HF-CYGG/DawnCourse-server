import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "redis";

// 服务端监听端口
const port = Number(process.env.PORT || 8080);
// 单次请求超时
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 20000);
// 请求体最大长度（默认 100 万字符，避免被动截断上传）
const maxContentLength = Number(process.env.MAX_CONTENT_LENGTH || 1000000);
// 任务缓存清理的最大存活时长
const taskTtlMs = Number(process.env.TASK_TTL_MS || 1800000);
// 请求幂等键缓存时间，避免短时间重复入队
const idempotentTtlMs = Number(process.env.IDEMPOTENT_TTL_MS || 10 * 60 * 1000);
// 模型名称别名映射表（JSON 格式），例如将 "glm5" 映射为 "glm-5"
let modelAliasJson = (process.env.LLM_MODEL_ALIAS_JSON || "").trim();
let modelAliasMap = safeJson(modelAliasJson) || {};
// 低成本总结模型配置（模型 1）
let summaryProviderRaw = (process.env.LLM_SUMMARY_PROVIDER || "gpt").toLowerCase();
let summaryApiKey = process.env.LLM_SUMMARY_API_KEY || "";
let summaryModelRaw =
  process.env.LLM_SUMMARY_MODEL ||
  defaultSummaryModel(summaryProviderRaw === "auto" ? "gpt" : summaryProviderRaw);
let summaryModel = resolveModelName(summaryModelRaw);
let summaryProvider = normalizeProvider(summaryProviderRaw, summaryModel);
let summaryBaseUrl = process.env.LLM_SUMMARY_BASE_URL || defaultBaseUrl(summaryProvider);
// 高成本脚本修复模型配置（模型 2）
let scriptProviderRaw = (process.env.LLM_SCRIPT_PROVIDER || "gpt").toLowerCase();
let scriptApiKey = process.env.LLM_SCRIPT_API_KEY || "";
let scriptModelRaw =
  process.env.LLM_SCRIPT_MODEL ||
  defaultScriptModel(scriptProviderRaw === "auto" ? "gpt" : scriptProviderRaw);
let scriptModel = resolveModelName(scriptModelRaw);
let scriptProvider = normalizeProvider(scriptProviderRaw, scriptModel);
let scriptBaseUrl = process.env.LLM_SCRIPT_BASE_URL || defaultBaseUrl(scriptProvider);
let provider = summaryProvider;
let apiKey = summaryApiKey;
let model = summaryModel;
let baseUrl = summaryBaseUrl;
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const redisConnectRetryMs = Math.max(500, Number(process.env.REDIS_CONNECT_RETRY_MS || 3000));
const redisConnectMaxAttempts = Math.max(1, Number(process.env.REDIS_CONNECT_MAX_ATTEMPTS || 20));
// 脚本输出目录
const scriptOutputDir = process.env.SCRIPT_OUTPUT_DIR || "/shared/parsers";
// 老版本脚本目录（支持逗号分隔多个目录），用于升级时回退读取与自动迁移
const legacyScriptOutputDirs = parseCommaList(
  process.env.LEGACY_SCRIPT_OUTPUT_DIRS || "/shared/scripts"
);
// 同一学校触发脚本修复的最小提交数
const minQueueSize = Number(process.env.MIN_QUEUE_SIZE || 3);
// 同一学校合并窗口（毫秒）
const mergeWindowMs = Number(process.env.MERGE_WINDOW_MS || 10 * 60 * 1000);
// 脚本更新后 24 小时内的二次提交处理窗口
const reprocessWindowMs = Number(process.env.REPROCESS_WINDOW_MS || 24 * 60 * 60 * 1000);
// 队列最大长度，避免单校堆积过多导致内存/Redis 膨胀
const maxQueueSize = Number(process.env.MAX_QUEUE_SIZE || 200);
// 单条提交在队列中的最长存活时间，过期后自动清理
const queueItemTtlMs = Number(process.env.QUEUE_ITEM_TTL_MS || 24 * 60 * 60 * 1000);
// 调度延迟，降低同一时间大量任务扎堆执行
const processDelayMs = Number(process.env.PROCESS_DELAY_MS || 2000);
// 学校级锁租约 TTL，避免异常情况下长期占用
const schoolLockTtlMs = Number(process.env.SCHOOL_LOCK_TTL_MS || 30000);
// 去重窗口：同校同内容短时间重复提交直接忽略
const dedupWindowMs = Number(process.env.DEDUP_WINDOW_MS || 10 * 60 * 1000);
// 全局限流：保护服务端与模型调用
const rateLimitPerMin = Number(process.env.RATE_LIMIT_PER_MIN || 120);
// 单学校限流：避免单校刷爆队列
const rateLimitSchoolPerMin = Number(process.env.RATE_LIMIT_SCHOOL_PER_MIN || 60);
// 全局并发上限：控制同时处理的学校数，平滑高负载
const maxSchoolConcurrency = Number(process.env.MAX_SCHOOL_CONCURRENCY || 4);
// 学校名模糊匹配阈值（越高越严格）
const schoolFuzzyThreshold = Number(process.env.SCHOOL_FUZZY_THRESHOLD || 0.82);
// 触发模糊匹配的最短名称长度，避免过短导致误归类
const schoolFuzzyMinLength = Number(process.env.SCHOOL_FUZZY_MIN_LENGTH || 4);
// 别名映射缓存时间，减少频繁读 Redis
const schoolAliasCacheMs = Number(process.env.SCHOOL_ALIAS_CACHE_MS || 10 * 60 * 1000);
// 模糊匹配结果缓存 TTL，避免重复计算
const schoolFuzzyCacheTtlSec = Number(process.env.SCHOOL_FUZZY_CACHE_TTL_SEC || 7 * 24 * 60 * 60);
// 每次调用模型的按次固定成本（USD），如需精细计费推荐使用 Per_MTOKEN
const summaryCostPerCall = Number(process.env.LLM_SUMMARY_COST_PER_CALL || 0);
const scriptCostPerCall = Number(process.env.LLM_SCRIPT_COST_PER_CALL || 0);
const parseCostPerCall = Number(process.env.LLM_PARSE_COST_PER_CALL || 0);
// 模型的 Token 计费单价（每百万 Token 的 USD 价格）
const summaryInputCostPerMTokens = Number(process.env.LLM_SUMMARY_INPUT_COST_PER_MTOKEN || 0);
const summaryOutputCostPerMTokens = Number(process.env.LLM_SUMMARY_OUTPUT_COST_PER_MTOKEN || 0);
const scriptInputCostPerMTokens = Number(process.env.LLM_SCRIPT_INPUT_COST_PER_MTOKEN || 0);
const scriptOutputCostPerMTokens = Number(process.env.LLM_SCRIPT_OUTPUT_COST_PER_MTOKEN || 0);
// 模型调用的额外请求体参数（JSON 格式），可用于配置如 response_format, tools 等平台专有参数
let summaryRequestExtraJson = (process.env.LLM_SUMMARY_REQUEST_EXTRA_JSON || "").trim();
let scriptRequestExtraJson = (process.env.LLM_SCRIPT_REQUEST_EXTRA_JSON || "").trim();
let summaryRequestExtra = safeJson(summaryRequestExtraJson) || null;
let scriptRequestExtra = safeJson(scriptRequestExtraJson) || null;
// 强制指定 API 风格（chat 或 responses），留空则自动推断（例如 GPT-5 默认 responses）
let summaryApiStyleRaw = (process.env.LLM_SUMMARY_API_STYLE || "").trim().toLowerCase();
let scriptApiStyleRaw = (process.env.LLM_SCRIPT_API_STYLE || "").trim().toLowerCase();
// 用量统计功能开关与查询配置
let usageEnabled = process.env.LLM_USAGE_ENABLED !== "false";
let usageLookbackDays = Number(process.env.LLM_USAGE_LOOKBACK_DAYS || 1);
let usageRefreshMs = Number(process.env.LLM_USAGE_REFRESH_MINUTES || 30) * 60 * 1000;
let summaryUsageUrl = (process.env.LLM_SUMMARY_USAGE_URL || "").trim();
let scriptUsageUrl = (process.env.LLM_SCRIPT_USAGE_URL || "").trim();
let summaryCostUrl = (process.env.LLM_SUMMARY_COST_URL || "").trim();
let scriptCostUrl = (process.env.LLM_SCRIPT_COST_URL || "").trim();
const scriptSignKey = process.env.SCRIPT_SIGN_KEY || "";
const scriptSignPrivateKey = normalizePemEnv(process.env.SCRIPT_SIGN_PRIVATE_KEY || "");
const schoolMetricsFile =
  process.env.SCHOOL_METRICS_FILE || path.join(scriptOutputDir, "metrics", "school_metrics.txt");
const metricsFlushMs = Number(process.env.METRICS_FLUSH_MS || 5000);
const offlineReplayDatasetJson = process.env.OFFLINE_REPLAY_DATASET_JSON || "";
const offlineReplayRequired = process.env.OFFLINE_REPLAY_REQUIRED === "true";
const canaryPercent = Number(process.env.CANARY_PERCENT || 0);
const canarySchoolsRaw = process.env.CANARY_SCHOOLS || "";
// 即时兜底解析最大重试次数
const parseMaxAttempts = Math.max(1, Number(process.env.PARSE_MAX_ATTEMPTS || 3));
const rollbackFailureWindowMs = Number(process.env.ROLLBACK_FAILURE_WINDOW_MS || 30 * 60 * 1000);
const rollbackFailureThreshold = Number(process.env.ROLLBACK_FAILURE_THRESHOLD || 3);
const backupTtlMs = Number(process.env.BACKUP_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const pendingParseRetryMs = Number(process.env.PENDING_PARSE_RETRY_MS || 15000);
const backpressurePendingThreshold = Number(process.env.BACKPRESSURE_PENDING_THRESHOLD || 20);
const backpressureMergeWindowMs = Number(
  process.env.BACKPRESSURE_MERGE_WINDOW_MS || Math.max(mergeWindowMs, 20 * 60 * 1000)
);
const degradeHighCostEnabled = process.env.DEGRADE_HIGH_COST === "true";
const issueClusterSimilarity = Number(process.env.ISSUE_CLUSTER_SIMILARITY || 0.45);
// 管理后台会话有效期（默认 12 小时）
const adminSessionTtlMs = Number(process.env.ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const adminLocalMode = process.env.ADMIN_LOCAL_MODE === "true";
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
// 管理后台静态页面本地调试根目录
// - ADMIN_WEB_ROOT：显式指定 server/html 的上级目录（内部会拼接 /admin）
// - 未指定时：若开启 ADMIN_LOCAL_MODE，则默认使用仓库自带的 server/html，便于本地直接访问 /admin/
const adminWebRootRaw = (process.env.ADMIN_WEB_ROOT || "").trim();
const adminWebRoot = adminWebRootRaw || (adminLocalMode ? path.resolve(currentDirPath, "..", "html") : "");
const adminStaticDir = adminWebRoot ? path.resolve(adminWebRoot, "admin") : "";
const adminIndexPath = adminWebRoot ? path.resolve(adminWebRoot, "admin", "index.html") : "";
// 服务启动时间戳，用于面板展示启动时长
const serverStartedAt = Date.now();
// 单次脚本修复并发控制（按学校粒度）
const schoolProcessing = new Map();
// 待处理学校集合，用于全局并发调度
const pendingSchools = new Set();
// 当前正在处理的学校数量
let activeSchoolProcessing = 0;
let metricsFlushTimer = null;
// 学校别名缓存，避免频繁扫描 Redis
let schoolAliasCache = {
  updatedAt: 0,
  map: new Map()
};
const adminLocalUsers = new Map();
const adminLocalSessions = new Map();
let usageRefreshTimer = null;
let pendingParseTimer = null;
const canarySchoolSet = parseCommaSet(canarySchoolsRaw);
const offlineReplayDataset = parseOfflineReplayDataset(offlineReplayDatasetJson);

const adminLogBufferLimit = Number(process.env.ADMIN_LOG_BUFFER_LIMIT || 300);
const adminLogBuffer = [];
const adminEventClients = new Set();
const scriptHistoryLimit = Number(process.env.SCRIPT_HISTORY_LIMIT || 200);
const scriptBackupDir = process.env.SCRIPT_BACKUP_DIR || path.join(scriptOutputDir, "backup_versions");
const scriptFeedbackErrorLimit = Number(process.env.SCRIPT_FEEDBACK_ERROR_LIMIT || 300);
const backendMirrorLogFile = (process.env.BACKEND_MIRROR_LOG_FILE || "/shared/parsers/llm-backend.log").trim();
const nginxAccessLogFile = (process.env.NGINX_ACCESS_LOG_FILE || "/shared/parsers/nginx_access.log").trim();
const nginxErrorLogFile = (process.env.NGINX_ERROR_LOG_FILE || "/shared/parsers/nginx_error.log").trim();
const runtimeLogReadBytes = Math.max(64 * 1024, Number(process.env.RUNTIME_LOG_READ_BYTES || 8 * 1024 * 1024));
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};
let mirrorLogWriteQueue = Promise.resolve();

function safeToLogString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function pushAdminLog(level, message, extra = {}) {
  const entry = {
    id: crypto.randomUUID(),
    level: level || "info",
    message: (message || "").toString(),
    extra: extra || {},
    createdAt: Date.now()
  };
  adminLogBuffer.push(entry);
  if (adminLogBuffer.length > adminLogBufferLimit) {
    adminLogBuffer.splice(0, adminLogBuffer.length - adminLogBufferLimit);
  }
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of adminEventClients) {
    try {
      if (client.res.writableEnded) continue;
      client.res.write(payload);
    } catch {}
  }
  return entry;
}

function appendMirrorLog(level, args) {
  if (!backendMirrorLogFile) return;
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(safeToLogString).join(" ")}\n`;
  mirrorLogWriteQueue = mirrorLogWriteQueue.then(() => fs.appendFile(backendMirrorLogFile, line)).catch(() => {});
}

console.log = (...args) => {
  nativeConsole.log(...args);
  appendMirrorLog("INFO", args);
};
console.error = (...args) => {
  nativeConsole.error(...args);
  appendMirrorLog("ERROR", args);
  pushAdminLog("error", args.map(safeToLogString).join(" "), { source: "server", type: "console" });
};
console.warn = (...args) => {
  nativeConsole.warn(...args);
  appendMirrorLog("WARN", args);
  pushAdminLog("warning", args.map(safeToLogString).join(" "), { source: "server", type: "console" });
};

process.on("unhandledRejection", (reason) => {
  pushAdminLog("error", safeToLogString(reason), { source: "server", type: "unhandledRejection" });
});
process.on("uncaughtException", (error) => {
  pushAdminLog("error", safeToLogString(error), { source: "server", type: "uncaughtException" });
});

// ---------------------------------------------------------------------------
// 动态配置管理
// ---------------------------------------------------------------------------

function applyDynamicConfig(conf) {
  if (!conf) return;

  if (conf.modelAliasJson !== undefined) {
    modelAliasJson = conf.modelAliasJson;
    modelAliasMap = safeJson(modelAliasJson) || {};
  }

  if (conf.summaryProviderRaw !== undefined) summaryProviderRaw = conf.summaryProviderRaw;
  if (conf.summaryApiKey !== undefined) summaryApiKey = conf.summaryApiKey;
  if (conf.summaryModelRaw !== undefined) summaryModelRaw = conf.summaryModelRaw;
  if (conf.summaryBaseUrl !== undefined) summaryBaseUrl = conf.summaryBaseUrl;
  if (conf.summaryRequestExtraJson !== undefined) summaryRequestExtraJson = conf.summaryRequestExtraJson;
  if (conf.summaryApiStyleRaw !== undefined) summaryApiStyleRaw = conf.summaryApiStyleRaw;

  summaryModel = resolveModelName(summaryModelRaw || defaultSummaryModel(summaryProviderRaw === "auto" ? "gpt" : summaryProviderRaw));
  summaryProvider = normalizeProvider(summaryProviderRaw, summaryModel);
  summaryBaseUrl = summaryBaseUrl || defaultBaseUrl(summaryProvider);
  summaryRequestExtra = safeJson(summaryRequestExtraJson) || null;

  if (conf.scriptProviderRaw !== undefined) scriptProviderRaw = conf.scriptProviderRaw;
  if (conf.scriptApiKey !== undefined) scriptApiKey = conf.scriptApiKey;
  if (conf.scriptModelRaw !== undefined) scriptModelRaw = conf.scriptModelRaw;
  if (conf.scriptBaseUrl !== undefined) scriptBaseUrl = conf.scriptBaseUrl;
  if (conf.scriptRequestExtraJson !== undefined) scriptRequestExtraJson = conf.scriptRequestExtraJson;
  if (conf.scriptApiStyleRaw !== undefined) scriptApiStyleRaw = conf.scriptApiStyleRaw;

  scriptModel = resolveModelName(scriptModelRaw || defaultScriptModel(scriptProviderRaw === "auto" ? "gpt" : scriptProviderRaw));
  scriptProvider = normalizeProvider(scriptProviderRaw, scriptModel);
  scriptBaseUrl = scriptBaseUrl || defaultBaseUrl(scriptProvider);
  scriptRequestExtra = safeJson(scriptRequestExtraJson) || null;

  provider = summaryProvider;
  apiKey = summaryApiKey;
  model = summaryModel;
  baseUrl = summaryBaseUrl;

  if (conf.usageEnabled !== undefined) usageEnabled = conf.usageEnabled;
  if (conf.summaryUsageUrl !== undefined) summaryUsageUrl = conf.summaryUsageUrl;
  if (conf.scriptUsageUrl !== undefined) scriptUsageUrl = conf.scriptUsageUrl;
  if (conf.summaryCostUrl !== undefined) summaryCostUrl = conf.summaryCostUrl;
  if (conf.scriptCostUrl !== undefined) scriptCostUrl = conf.scriptCostUrl;
}

async function loadDynamicConfig() {
  if (adminLocalMode) return;
  try {
    const raw = await redisClient.get("admin:llm_config");
    if (raw) {
      applyDynamicConfig(safeJson(raw));
    }
  } catch (e) {
    console.error("loadDynamicConfig error:", e);
  }
}

// ---------------------------------------------------------------------------
// 初始化与全局变量
// ---------------------------------------------------------------------------
const redisClient = createClient({ url: redisUrl });
let redisReady = false;
const redisUrlRaw = (process.env.REDIS_URL || "").trim();
const shouldConnectRedis = !adminLocalMode || Boolean(redisUrlRaw);
redisClient.on("error", (error) => {
  console.error("redis error:", error);
});
redisClient.on("ready", () => {
  redisReady = true;
});
redisClient.on("end", () => {
  redisReady = false;
});
async function connectRedisWithRetry() {
  if (!shouldConnectRedis) return false;
  for (let attempt = 1; attempt <= redisConnectMaxAttempts; attempt += 1) {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      redisReady = true;
      await loadDynamicConfig();
      return true;
    } catch (e) {
      redisReady = false;
      console.error(`redis connect attempt ${attempt}/${redisConnectMaxAttempts} failed:`, e);
      if (attempt < redisConnectMaxAttempts) {
        await sleep(redisConnectRetryMs);
      }
    }
  }
  return false;
}
try {
  await connectRedisWithRetry();
} catch (e) {
  console.error("redis init error:", e);
}
const adminBootstrapInfo = await initAdminUserStore();
if (adminBootstrapInfo?.username && adminBootstrapInfo?.password) {
  console.log(
    `admin credentials: username=${adminBootstrapInfo.username} password=${adminBootstrapInfo.password}`
  );
} else {
  console.warn("admin credentials unavailable");
}
await ensureStorageLayout();
if (usageEnabled && !adminLocalMode) {
  scheduleUsageRefresh();
}
if (redisReady) {
  schedulePendingParseProcessing();
}

// ---------------------------------------------------------------------------
// HTTP 服务入口
// 提供客户端任务提交、状态轮询，以及管理后台的各种 API
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  (async () => {
  const url = new URL(req.url || "/", "http://localhost");
  // 健康检查接口
  if (req.method === "GET" && url.pathname === "/health") {
    if (shouldConnectRedis && !redisReady) {
      return sendJson(res, 503, { ok: false, redisReady: false });
    }
    return sendJson(res, 200, { ok: true });
  }
  // ---------------------------------------------------------------------------
  // [本地调试] 管理后台静态页面（仅当配置 ADMIN_WEB_ROOT 时启用）
  // ---------------------------------------------------------------------------
  if (
    adminWebRoot &&
    req.method === "GET" &&
    url.pathname.startsWith("/admin")
  ) {
    if (url.pathname === "/admin") {
      res.writeHead(302, { Location: "/admin/" });
      res.end();
      return;
    }
    const relPath = url.pathname === "/admin/" ? "index.html" : url.pathname.replace(/^\/admin\//, "");
    return sendAdminStaticFile(res, relPath);
  }
  if (adminLocalMode && req.method === "GET" && url.pathname === "/") {
    res.writeHead(302, { Location: "/admin/" });
    res.end();
    return;
  }
  if (
    adminLocalMode &&
    !url.pathname.startsWith("/admin") &&
    !url.pathname.startsWith("/api/v1/admin")
  ) {
    return sendJson(res, 503, { code: 503, msg: "admin local mode only" });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/metrics") {
    const metrics = await getMetricsSnapshot();
    return sendJson(res, 200, { code: 200, data: metrics });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/script_failures") {
    const limit = Number(url.searchParams.get("limit") || 50);
    const failures = await getScriptFailures(limit);
    return sendJson(res, 200, { code: 200, data: failures });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/school_status") {
    const schoolId = url.searchParams.get("schoolId") || "";
    if (!schoolId) {
      return sendJson(res, 400, { code: 400, msg: "缺少 schoolId" });
    }
    const status = await getSchoolStatus(schoolId);
    return sendJson(res, 200, { code: 200, data: status });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/script_meta") {
    const scriptName = url.searchParams.get("scriptName") || "";
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    const meta = await getScriptMeta(scriptName);
    if (!meta) {
      return sendJson(res, 404, { code: 404, msg: "meta 不存在" });
    }
    return sendJson(res, 200, { code: 200, data: meta });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/scripts/manifest") {
    const manifest = await buildScriptManifest(req);
    return sendJson(res, 200, manifest);
  }
  if (req.method === "POST" && url.pathname === "/api/v1/script_feedback") {
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const scriptVersion = Number(body?.scriptVersion || body?.script_version || 0);
    const success = body?.success === true;
    const category = (body?.category || "").toString();
    const errorMessage = (body?.errorMessage || body?.error_message || "").toString();
    const sourceUrl = (body?.sourceUrl || body?.source_url || "").toString();
    const parseSessionId = (body?.parseSessionId || body?.parse_session_id || "").toString().trim();
    const isSessionFinal = body?.isSessionFinal === true || body?.is_session_final === true;
    const finalResult = (body?.finalResult || body?.final_result || "").toString();
    const failureType = (body?.failureType || body?.failure_type || "").toString();
    const schoolSystemType = (body?.schoolSystemType || body?.school_system_type || "").toString();
    const attemptedParsersRaw = body?.attemptedParsers || body?.attempted_parsers || [];
    const attemptedParsers = Array.isArray(attemptedParsersRaw)
      ? attemptedParsersRaw.map((item) => sanitizeScriptName(item)).filter(Boolean).slice(0, 12)
      : [];
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    await recordScriptParseFeedback({
      scriptName,
      scriptVersion,
      success,
      category,
      errorMessage,
      sourceUrl,
      parseSessionId,
      isSessionFinal,
      finalResult,
      failureType,
      schoolSystemType,
      attemptedParsers
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/parse/report") {
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    if (!redisReady) {
      return sendJson(res, 503, { code: 503, msg: "Redis 未连接" });
    }
    const body = safeJson(bodyText) || {};
    const sample = body?.sanitizedSample || null;
    const sampleContent = (sample?.content || "").toString();
    const hasConsent = sample?.hasUserConsent === true;
    if (sampleContent && !hasConsent) {
      return sendJson(res, 400, { code: 400, msg: "样本内容必须经用户同意后上传" });
    }
    const result = await recordParseReport(body);
    return sendJson(res, 200, {
      accepted: true,
      issueId: result.issueId || "",
      cloudFallbackAvailable: true
    });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/script_pull") {
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const category = (body?.category || "").toString();
    const source = (body?.source || "").toString();
    const pullTaskId = (body?.pullTaskId || body?.pull_task_id || "").toString();
    const fromCloud = body?.fromCloud === true;
    await recordScriptPull({
      scriptName,
      category,
      source,
      pullTaskId,
      fromCloud,
      clientIp: req.socket?.remoteAddress || "",
      userAgent: (req.headers?.["user-agent"] || "").toString()
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const text = await buildPrometheusMetrics();
    return sendText(res, 200, text);
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 登录
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/admin/login") {
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText);
    const username = (body?.username || "").toString();
    const password = (body?.password || "").toString();
    if (!username || !password) {
      return sendJson(res, 400, { code: 400, msg: "缺少账号或密码" });
    }
    const verified = await verifyAdminCredentials(username, password);
    if (!verified) {
      return sendJson(res, 401, { code: 401, msg: "账号或密码错误" });
    }
    const token = await createAdminSession(username);
    await touchAdminUserLogin(username);
    return sendJson(res, 200, { code: 200, data: { token, username } });
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 退出
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/admin/logout") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    await deleteAdminSession(auth.token);
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 会话校验
  // ---------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/v1/admin/session") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    return sendJson(res, 200, { code: 200, data: { username: auth.username } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/events") {
    const token = (url.searchParams.get("token") || "").trim();
    const auth = await requireAdminAuthByToken(token);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, username: auth.username })}\n\n`);
    const snapshot = adminLogBuffer.slice(-Math.min(50, adminLogBuffer.length));
    for (const item of snapshot) {
      res.write(`event: log\ndata: ${JSON.stringify(item)}\n\n`);
    }
    const client = { res };
    adminEventClients.add(client);
    const pingTimer = setInterval(() => {
      try {
        if (!res.writableEnded) res.write("event: ping\ndata: {}\n\n");
      } catch {}
    }, 25000);
    req.on("close", () => {
      clearInterval(pingTimer);
      adminEventClients.delete(client);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/logs") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
    const list = adminLogBuffer.slice(-limit);
    return sendJson(res, 200, { code: 200, data: { list } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/users") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const list = await listAdminUsers();
    return sendJson(res, 200, { code: 200, data: { list } });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/users") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const result = await createAdminUser(body.username, body.password);
    if (!result.ok) {
      return sendJson(res, result.code || 400, { code: result.code || 400, msg: result.msg || "创建失败" });
    }
    pushAdminLog("info", "新增管理账号", {
      source: "admin-api",
      operator: auth.username,
      username: (body.username || "").toString()
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/users/rename") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const result = await renameAdminUser(body.oldUsername, body.newUsername);
    if (!result.ok) {
      return sendJson(res, result.code || 400, { code: result.code || 400, msg: result.msg || "修改失败" });
    }
    pushAdminLog("warning", "修改管理账号", {
      source: "admin-api",
      operator: auth.username,
      oldUsername: (body.oldUsername || "").toString(),
      newUsername: (body.newUsername || "").toString()
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/users/password") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const result = await updateAdminUserPassword(body.username, body.newPassword);
    if (!result.ok) {
      return sendJson(res, result.code || 400, { code: result.code || 400, msg: result.msg || "修改失败" });
    }
    pushAdminLog("warning", "重置管理账号密码", {
      source: "admin-api",
      operator: auth.username,
      username: (body.username || "").toString()
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/users/delete") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const username = (body.username || "").toString().trim();
    if (!username) {
      return sendJson(res, 400, { code: 400, msg: "账号不能为空" });
    }
    if (username === auth.username) {
      return sendJson(res, 400, { code: 400, msg: "不允许删除当前登录账号" });
    }
    const result = await deleteAdminUser(username);
    if (!result.ok) {
      return sendJson(res, result.code || 400, { code: result.code || 400, msg: result.msg || "删除失败" });
    }
    pushAdminLog("warning", "删除管理账号", {
      source: "admin-api",
      operator: auth.username,
      username
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/runtime_logs") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const source = (url.searchParams.get("source") || "all").toString();
    const limit = Math.max(1, Math.min(20000, Number(url.searchParams.get("limit") || 1000)));
    const data = await getRuntimeLogLines(source, limit);
    return sendJson(res, 200, { code: 200, data });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/client_error") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    pushAdminLog("error", (body.message || "client error").toString(), {
      source: "client",
      username: auth.username,
      stack: (body.stack || "").toString(),
      url: (body.url || "").toString(),
      userAgent: (body.userAgent || "").toString(),
      extra: body.extra || null
    });
    return sendJson(res, 200, { code: 200, msg: "ok" });
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 聚合数据
  // 供管理面板使用，返回包含核心统计指标和失败列表的综合数据
  // ---------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/v1/admin/data") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const data = await buildAdminDashboardData();
    return sendJson(res, 200, { code: 200, data });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/repair/issues") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const list = await listRepairIssues(Number(url.searchParams.get("limit") || 100));
    return sendJson(res, 200, { code: 200, data: { list } });
  }
  if (req.method === "GET" && /^\/api\/admin\/repair\/issues\/[^/]+$/.test(url.pathname)) {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const issueId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const detail = await getRepairIssueDetail(issueId);
    if (!detail) {
      return sendJson(res, 404, { code: 404, msg: "Issue 不存在" });
    }
    return sendJson(res, 200, { code: 200, data: detail });
  }
  if (req.method === "POST" && /^\/api\/admin\/repair\/issues\/[^/]+\/run-test$/.test(url.pathname)) {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const issueId = decodeURIComponent(url.pathname.split("/").slice(-2)[0] || "");
    const result = await runRepairIssueTest(issueId, auth.username);
    if (!result.ok) {
      return sendJson(res, result.code || 400, { code: result.code || 400, msg: result.reason || "测试失败" });
    }
    return sendJson(res, 200, { code: 200, data: result });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/scripts/releases") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText) || {};
    const scriptName = sanitizeScriptName(body?.name || body?.scriptName || "");
    const content = (body?.content || "").toString();
    const releaseStage = normalizeReleaseStage(body?.releaseStage || body?.status || "pending");
    if (!scriptName || !content) {
      return sendJson(res, 400, { code: 400, msg: "缺少脚本名或内容" });
    }
    const previousContent = await readScript(scriptName);
    const previousMeta = await getScriptMeta(scriptName);
    const result = await applyScriptUpdate(scriptName, content, previousContent, {
      previousMeta,
      forceRelease: releaseStage !== "pending",
      releaseStage,
      appliedBy: auth.username,
      actionType: `admin_release_${releaseStage}`,
      context: {
        releaseId: (body?.releaseId || "").toString(),
        changelog: (body?.changelog || "").toString(),
        targetSchoolSystemTypes: Array.isArray(body?.targetSchoolSystemTypes) ? body.targetSchoolSystemTypes : [],
        targetSchoolIds: Array.isArray(body?.targetSchoolIds) ? body.targetSchoolIds : []
      }
    });
    if (!result.ok) {
      return sendJson(res, 400, { code: 400, msg: result.reason || "发布失败", data: result });
    }
    const meta = await getScriptMeta(scriptName);
    return sendJson(res, 200, { code: 200, data: { meta, result } });
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 晋升灰度脚本 (Pending -> Active/Canary)
  // 用于管理员手动干预：将因灰度策略或验证拦截而处于 pending 状态的脚本发布
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/admin/promote_script") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    if (!redisReady) {
      return sendJson(res, 503, { code: 503, msg: "Redis 未连接，无法发布 pending 脚本" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText);
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const pushMode = (body?.pushMode || body?.push_mode || "").toString();
    const releaseStageRaw = (body?.releaseStage || body?.release_stage || pushMode || "active").toString();
    const releaseStage = normalizeReleaseStage(releaseStageRaw);
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    const pending = await loadPendingScript(scriptName);
    if (!pending) {
      return sendJson(res, 404, { code: 404, msg: "未找到待发布脚本" });
    }
    const confirmPublish = body?.confirmPublish === true || body?.confirm_publish === true;
    const confirmToken = (body?.confirmToken || body?.confirm_token || "").toString();
    const expectedToken = buildPublishConfirmToken(scriptName, releaseStage, pending);
    if (!confirmPublish) {
      return sendJson(res, 409, {
        code: 409,
        msg: "请二次确认后发布",
        data: { confirmToken: expectedToken, releaseStage }
      });
    }
    if (confirmToken !== expectedToken) {
      return sendJson(res, 400, { code: 400, msg: "二次确认令牌无效，请刷新后重试" });
    }
    const previousContent = await readScript(scriptName);
    const previousMeta = await getScriptMeta(scriptName);
    const result = await applyScriptUpdate(scriptName, pending, previousContent, {
      previousMeta,
      forceRelease: true,
      releaseStage,
      appliedBy: auth.username,
      actionType: releaseStage === "canary" ? "promote_canary" : "promote_active"
    });
    if (!result.ok) {
      return sendJson(res, 500, { code: 500, msg: result.reason || "发布失败" });
    }
    if (!result.pending) {
      await clearPendingScript(scriptName);
    }
    const meta = await getScriptMeta(scriptName);
    return sendJson(res, 200, { code: 200, data: { meta } });
  }
  // ---------------------------------------------------------------------------
  // [管理后台接口] 回滚脚本 (Rollback)
  // 用于管理员手动干预：将出现问题的脚本回退到上一个版本或指定版本
  // 回滚操作同样会经过完整的校验和落盘流程
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/admin/rollback_script") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    if (!redisReady) {
      return sendJson(res, 503, { code: 503, msg: "Redis 未连接，无法从备份回滚" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText);
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const targetVersion = Number(body?.targetVersion || body?.target_version || 0);
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    const currentMeta = await getScriptMeta(scriptName);
    if (!currentMeta) {
      return sendJson(res, 404, { code: 404, msg: "meta 不存在" });
    }
    const version = targetVersion || Number(currentMeta.parentVersion || 0);
    if (!version) {
      return sendJson(res, 400, { code: 400, msg: "缺少可回滚版本" });
    }
    const backup = await loadScriptBackup(scriptName, version);
    if (!backup) {
      return sendJson(res, 404, { code: 404, msg: "回滚内容不存在" });
    }
    const previousContent = await readScript(scriptName);
    const result = await applyScriptUpdate(scriptName, backup, previousContent, {
      previousMeta: currentMeta,
      forceRelease: true,
      releaseStage: "rollback",
      appliedBy: auth.username,
      actionType: "rollback_admin"
    });
    if (!result.ok) {
      return sendJson(res, 500, { code: 500, msg: result.reason || "回滚失败" });
    }
    const meta = await getScriptMeta(scriptName);
    return sendJson(res, 200, { code: 200, data: { meta } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/scripts") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const list = await listAdminScripts();
    return sendJson(res, 200, { code: 200, data: { list } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/script_content") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const scriptName = (url.searchParams.get("scriptName") || url.searchParams.get("script_name") || "")
      .toString()
      .trim();
    const source = (url.searchParams.get("source") || "current").toString();
    const version = Number(url.searchParams.get("version") || 0);
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    let content = "";
    if (source === "pending") {
      content = (await loadPendingScript(scriptName)) || "";
    } else if (source === "backup") {
      content = (await loadScriptBackup(scriptName, version)) || "";
    } else {
      content = (await readScript(scriptName)) || "";
    }
    if (!content) {
      return sendJson(res, 404, { code: 404, msg: "内容不存在或已过期" });
    }
    const meta = await getScriptMeta(scriptName);
    return sendJson(res, 200, { code: 200, data: { content, meta } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/script_history") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const scriptName = (url.searchParams.get("scriptName") || url.searchParams.get("script_name") || "")
      .toString()
      .trim();
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
    const list = await getScriptHistory(scriptName, limit);
    return sendJson(res, 200, { code: 200, data: { list } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/config") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const config = {
      modelAliasJson,
      summaryProviderRaw,
      summaryApiKey,
      summaryModelRaw,
      summaryBaseUrl,
      summaryRequestExtraJson,
      summaryApiStyleRaw,
      scriptProviderRaw,
      scriptApiKey,
      scriptModelRaw,
      scriptBaseUrl,
      scriptRequestExtraJson,
      scriptApiStyleRaw,
      usageEnabled,
      summaryUsageUrl,
      scriptUsageUrl,
      summaryCostUrl,
      scriptCostUrl
    };
    return sendJson(res, 200, { code: 200, data: config });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/config") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    if (adminLocalMode) {
      return sendJson(res, 400, { code: 400, msg: "本地调试模式不支持修改配置" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (!bodyText) return sendJson(res, 400, { code: 400, msg: "无效请求体" });
    const conf = safeJson(bodyText);
    if (!conf) return sendJson(res, 400, { code: 400, msg: "无效 JSON" });

    // Validate if necessary (e.g., alias json format)
    if (conf.modelAliasJson) {
      const parsed = safeJson(conf.modelAliasJson);
      if (!parsed || typeof parsed !== "object") {
        return sendJson(res, 400, { code: 400, msg: "别名映射格式必须为有效的 JSON 对象" });
      }
    }
    if (conf.summaryRequestExtraJson) {
      const parsed = safeJson(conf.summaryRequestExtraJson);
      if (!parsed || typeof parsed !== "object") {
        return sendJson(res, 400, { code: 400, msg: "扩展参数格式必须为有效的 JSON 对象" });
      }
    }
    if (conf.scriptRequestExtraJson) {
      const parsed = safeJson(conf.scriptRequestExtraJson);
      if (!parsed || typeof parsed !== "object") {
        return sendJson(res, 400, { code: 400, msg: "扩展参数格式必须为有效的 JSON 对象" });
      }
    }

    try {
      await redisClient.set("admin:llm_config", JSON.stringify(conf));
      applyDynamicConfig(conf);
      schedulePendingParseProcessing();
      return sendJson(res, 200, { code: 200, msg: "保存成功" });
    } catch (e) {
      return sendJson(res, 500, { code: 500, msg: "保存失败: " + e.message });
    }
  }

  // ---------------------------------------------------------------------------
  // [核心接口] 提交解析任务
  // 1. 拦截重复提交（幂等性）
  // 2. 限流与风控
  // 3. 将任务存入学校维度队列，进入异步合并窗口
  // 4. 返回 taskId 供客户端轮询
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/parse_task") {
    // 读取请求体并限制长度
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    // 解析 JSON
    const body = safeJson(bodyText);
    const content = (body?.content || "").toString();
    const schoolIdInput = (body?.schoolId || body?.school_id || "").toString();
    const schoolNameInput = (body?.schoolName || body?.school_name || "").toString();
    const schoolSystemTypeInput = (body?.schoolSystemType || body?.systemType || "").toString();
    const sourceUrl = (body?.sourceUrl || body?.source_url || "").toString().trim();
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const scriptVersion = Number(body?.scriptVersion || body?.script_version || 0);
    const scriptSource = (body?.scriptSource || body?.script_source || "").toString();
    const failureTypeInput = (body?.failureType || body?.failure_type || "").toString();
    const attemptedParsersRaw = body?.attemptedParsers || body?.attempted_parsers || [];
    const attemptedParsers = Array.isArray(attemptedParsersRaw)
      ? attemptedParsersRaw.map((item) => sanitizeScriptName(item)).filter(Boolean).slice(0, 12)
      : [];
    const clientVersion = (body?.clientVersion || body?.client_version || "").toString();
    const parseSessionId = (body?.parseSessionId || body?.parse_session_id || "").toString().trim();
    const issueId = (body?.issueId || body?.issue_id || "").toString().trim();
    const userConsent = body?.userConsent === true || body?.consent === true;
    // content 不能为空
    if (!content) {
      return sendJson(res, 400, { code: 400, msg: "缺少 content" });
    }
    // 必须有用户明确同意，避免静默上传
    if (!userConsent) {
      return sendJson(res, 400, { code: 400, msg: "需要用户明确同意后才能上传" });
    }
    // Redis 是队列、幂等、速率限制与指标统计的基础依赖；未连接时直接阻断，避免请求半路报错
    if (!redisReady) {
      return sendJson(res, 503, { code: 503, msg: "服务端 Redis 未连接，请稍后再试" });
    }
    const safeContent = sanitizeContent(content);
    const inferredSchoolName =
      schoolNameInput || extractSchoolNameFromContent(content) || extractSchoolNameFromContent(safeContent) || "";
    const schoolId = await resolveSchoolIdByName(schoolIdInput, inferredSchoolName);
    const schoolName = inferredSchoolName || "";
    const clientIp = getClientIp(req);
    const rateAllowed = await checkRateLimit(clientIp, schoolId);
    if (!rateAllowed) {
      return sendJson(res, 429, { code: 429, msg: "请求过于频繁" });
    }
    const contentHash = hashText(safeContent);
    const scriptHash = scriptName ? hashText(await readScript(scriptName)) : "";
    const idempotentKey = buildIdempotentKey({
      schoolId,
      scriptName,
      contentHash,
      scriptHash,
      clientVersion
    });
    const existingTaskId = await redisClient.get(idempotentKey);
    if (existingTaskId) {
      const existingTask = await getTask(existingTaskId);
      if (existingTask) {
        return sendJson(res, 200, {
          code: 200,
          msg: "ok",
          taskId: existingTaskId,
          schoolId: existingTask.schoolId || schoolId,
          schoolName: existingTask.schoolName || schoolName,
          schoolSystemType: existingTask.schoolSystemType || "unknown"
        });
      }
    }
    const candidateUrls = extractCandidateUrls(content, safeContent, sourceUrl);
    const classification = await resolveSubmissionClassification({
      content: safeContent,
      sourceUrl,
      failureTypeInput,
      schoolSystemTypeInput,
      attemptedParsers,
      scriptName
    });
    const schoolSystemType = classification.schoolSystemType;
    if (schoolId) {
      await saveSchoolInfo(schoolId, schoolName, schoolSystemType, candidateUrls, {
        systemSource: classification.schoolSystemSource
      });
    }
    // 生成任务并进入异步处理
    const taskId = crypto.randomUUID();
    const parseProviderReady = isParseProviderReady();
    await saveTask(taskId, {
      status: parseProviderReady ? "PROCESSING" : "PENDING",
      result: null,
      createdAt: Date.now(),
      pendingReason: parseProviderReady ? "" : "provider_not_ready",
      schoolId,
      schoolName,
      schoolSystemType,
      sourceUrl,
      scriptName,
      scriptVersion,
      scriptSource,
      failureType: failureTypeInput,
      classifiedFailureType: classification.failureType,
      failureCategory: classification.failureCategory,
      failureSource: classification.failureSource,
      schoolSystemSource: classification.schoolSystemSource,
      clientVersion,
      parseSessionId,
      issueId,
      attemptedParsers
    });
    if (parseProviderReady) {
      runTask(taskId, safeContent, schoolId).catch(async () => {
        const existing = (await getTask(taskId)) || {};
        await saveTask(taskId, {
          ...existing,
          status: "FAILED",
          result: null,
          createdAt: existing.createdAt || Date.now(),
          completedAt: Date.now(),
          schoolId,
          schoolName,
          schoolSystemType,
          sourceUrl,
          scriptName,
          scriptVersion,
          scriptSource,
          failureType: failureTypeInput,
          classifiedFailureType: classification.failureType,
          failureCategory: classification.failureCategory,
          failureSource: classification.failureSource,
          schoolSystemSource: classification.schoolSystemSource,
          clientVersion,
          parseSessionId,
          issueId,
          attemptedParsers
        });
      });
    } else {
      await enqueuePendingParseTask({
        taskId,
        content: safeContent,
        schoolId,
        schoolName,
        schoolSystemType,
        sourceUrl,
        scriptName,
        scriptVersion,
        scriptSource,
        failureType: failureTypeInput,
        classifiedFailureType: classification.failureType,
        failureCategory: classification.failureCategory,
        failureSource: classification.failureSource,
        schoolSystemSource: classification.schoolSystemSource,
        clientVersion,
        parseSessionId,
        issueId,
        attemptedParsers
      });
      schedulePendingParseProcessing();
    }
    if (schoolId) {
      await enqueueSchoolSubmission(schoolId, safeContent, scriptName, {
        schoolName,
        schoolSystemType,
        sourceUrl,
        candidateUrls,
        scriptVersion,
        scriptSource,
        failureType: failureTypeInput,
        classifiedFailureType: classification.failureType,
        failureCategory: classification.failureCategory,
        failureSource: classification.failureSource,
        schoolSystemSource: classification.schoolSystemSource,
        clientVersion,
        parseSessionId,
        issueId,
        attemptedParsers
      });
    }
    await redisClient.set(idempotentKey, taskId, { PX: idempotentTtlMs });
    return sendJson(res, 200, {
      code: 200,
      msg: parseProviderReady ? "ok" : "accepted_pending_model_key",
      taskId,
      schoolId,
      schoolName,
      schoolSystemType,
      parseProviderReady
    });
  }
  // ---------------------------------------------------------------------------
  // [核心接口] 轮询任务状态
  // 客户端在提交后通过此接口轮询任务执行结果
  // ---------------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/v1/task_status") {
    const taskId = url.searchParams.get("taskId") || "";
    if (!taskId) {
      return sendJson(res, 400, { code: 400, msg: "缺少 taskId" });
    }
    const task = await getTask(taskId);
    if (!task) {
      return sendJson(res, 404, { code: 404, msg: "任务不存在" });
    }
    return sendJson(res, 200, {
      code: 200,
      data: {
        status: task.status,
        result: task.result,
        pendingReason: task.pendingReason || "",
        queuedAt: Number(task.createdAt || 0),
        startedAt: Number(task.startedAt || 0),
        completedAt: Number(task.completedAt || 0),
        schoolId: task.schoolId || "",
        schoolName: task.schoolName || "",
        schoolSystemType: task.schoolSystemType || "unknown"
      }
    });
  }
  return sendJson(res, 404, { code: 404, msg: "Not Found" });
  })().catch((error) => {
    pushAdminLog("error", safeToLogString(error), {
      source: "server",
      type: "requestUnhandled",
      path: req?.url || ""
    });
    try {
      if (!res.headersSent && !res.writableEnded) {
        return sendJson(res, 500, { code: 500, msg: "Internal Server Error" });
      }
    } catch {}
  });
});

// 启动服务
server.listen(port, () => {
  console.log(`llm-backend listening on ${port}`);
});

async function buildScriptManifest(req) {
  const now = Date.now();
  const baseUrl = getPublicBaseUrl(req);
  const scripts = await listManifestScripts(baseUrl);
  const payload = {
    manifestVersion: now,
    generatedAt: now,
    minClientVersionCode: 0,
    scripts
  };
  const signed = signScript(JSON.stringify(payload));
  return { ...payload, signature: signed.signature, alg: signed.alg };
}

function getPublicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "") + "/";
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim() || "https";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();
  return `${proto}://${host}/`;
}

async function listManifestScripts(baseUrl) {
  const entries = [];
  await collectManifestScripts(entries, baseUrl, scriptOutputDir, "parsers");
  await collectManifestScripts(entries, baseUrl, path.join(scriptOutputDir, "js"), "js");
  return entries.sort((a, b) => {
    const categoryOrder = a.category.localeCompare(b.category);
    if (categoryOrder !== 0) return categoryOrder;
    return a.name.localeCompare(b.name);
  });
}

async function collectManifestScripts(entries, baseUrl, dir, category) {
  let files = [];
  try {
    files = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".js")) continue;
    const name = sanitizeScriptName(file.name);
    const fullPath = path.join(dir, name);
    const content = await readTextIfExists(fullPath);
    if (!content) continue;
    const meta = category === "parsers" ? await getScriptMeta(name) : await readCategoryScriptMeta(dir, name);
    const contentHash = hashText(content);
    const signed = meta?.signature ? { signature: meta.signature, alg: meta.alg || "rsa-sha256" } : signScript(content);
    const version = Number(meta?.version || 1);
    entries.push({
      scriptId: `${category}.${name.replace(/\.js$/i, "")}`,
      category,
      name,
      version,
      releaseId: (meta?.releaseId || meta?.release_id || `rel_${version}`).toString(),
      channel: normalizeReleaseStage(meta?.releaseStage || meta?.release_stage || "active"),
      url: `${baseUrl}scripts/${category}/${encodeURIComponent(name)}`,
      metaUrl: `${baseUrl}scripts/${category}/${encodeURIComponent(buildScriptMetaFileName(name))}`,
      sha256: meta?.sha256 || contentHash,
      signature: signed.signature || "",
      alg: signed.alg || "",
      priority: Number(meta?.priority || 0),
      schoolSystemTypes: normalizeManifestArray(meta?.schoolSystemTypes || meta?.school_system_types),
      schoolIds: normalizeManifestArray(meta?.schoolIds || meta?.school_ids),
      rolloutPercent: Number(meta?.rolloutPercent ?? meta?.rollout_percent ?? 100),
      killSwitch: meta?.killSwitch === true || meta?.disabled === true,
      minAppVersionCode: Number(meta?.minAppVersionCode || meta?.min_app_version_code || 0),
      maxAppVersionCode: Number(meta?.maxAppVersionCode || meta?.max_app_version_code || 0) || null,
      parserApiVersion: Number(meta?.parserApiVersion || meta?.parser_api_version || 1),
      dependencies: Array.isArray(meta?.dependencies) ? meta.dependencies : [],
      changelog: (meta?.changelog || "").toString()
    });
  }
}

async function readCategoryScriptMeta(dir, scriptName) {
  const raw = await readTextIfExists(path.join(dir, buildScriptMetaFileName(scriptName)));
  return raw ? safeJson(raw) : null;
}

function normalizeManifestArray(value) {
  if (Array.isArray(value)) return value.map((item) => item.toString()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizePemEnv(value) {
  const text = (value || "").toString().trim();
  if (!text) return "";
  return text.replace(/\\n/g, "\n");
}

async function recordParseReport(body) {
  const session = body?.session || {};
  const parseSessionId = (session.parseSessionId || session.parse_session_id || "").toString().trim();
  if (!parseSessionId) return { issueId: "" };
  const now = Date.now();
  const attempts = Array.isArray(body?.attempts) ? body.attempts.slice(0, 20) : [];
  const pageFingerprint = body?.pageFingerprint || body?.page_fingerprint || null;
  const sanitizedSample = body?.sanitizedSample || body?.sanitized_sample || null;
  const finalSuccess = body?.finalSuccess === true || body?.final_success === true;
  const finalFailureType = normalizeParseFailureType(body?.finalFailureType || body?.final_failure_type || "");
  const storedSession = {
    parseSessionId,
    appVersionCode: Number(session.appVersionCode || session.app_version_code || 0),
    appVersionName: (session.appVersionName || session.app_version_name || "").toString(),
    installBucketIdHash: (session.installBucketIdHash || session.install_bucket_id_hash || "").toString(),
    schoolId: (session.schoolId || session.school_id || "").toString(),
    schoolName: (session.schoolName || session.school_name || "").toString(),
    schoolSystemType: normalizeReportSchoolSystemType(session.schoolSystemType || session.school_system_type || ""),
    importSource: (session.importSource || session.import_source || "UNKNOWN").toString(),
    sourceUrlHost: (session.sourceUrlHost || session.source_url_host || "").toString(),
    pageFingerprintHash: hashText(JSON.stringify(pageFingerprint || {})),
    finalSuccess,
    finalFailureType,
    createdAt: Number(session.startedAt || session.started_at || now),
    updatedAt: now
  };
  await redisClient.set(buildParseSessionKey(parseSessionId), JSON.stringify(storedSession), { PX: queueItemTtlMs });
  if (attempts.length > 0) {
    const attemptKey = buildParserAttemptsKey(parseSessionId);
    await redisClient.del(attemptKey);
    await redisClient.rPush(attemptKey, attempts.map((item) => JSON.stringify(normalizeParserAttempt(item))));
    await redisClient.expire(attemptKey, Math.ceil(queueItemTtlMs / 1000));
  }
  if (finalSuccess) return { issueId: "" };
  const failedAttempt = attempts.find((item) => item && item.success !== true) || attempts[0] || {};
  const issue = await upsertRepairIssue({
    session: storedSession,
    pageFingerprint,
    attempt: normalizeParserAttempt(failedAttempt),
    finalFailureType,
    parseSessionId
  });
  if (sanitizedSample?.content && sanitizedSample?.hasUserConsent === true) {
    await saveFailureSample(issue.issueId, {
      parseSessionId,
      content: sanitizedSample.content.toString(),
      contentSha256: (sanitizedSample.contentSha256 || "").toString() || hashText(sanitizedSample.content.toString()),
      sanitizerVersion: Number(sanitizedSample.sanitizerVersion || 0),
      pageFingerprint,
      schoolId: storedSession.schoolId,
      schoolSystemType: storedSession.schoolSystemType,
      sourceUrlHost: storedSession.sourceUrlHost,
      createdAt: now
    });
  }
  return { issueId: issue.issueId };
}

function normalizeParserAttempt(item) {
  return {
    parserName: sanitizeScriptName(item?.parserName || item?.parser_name || ""),
    category: (item?.category || "parsers").toString(),
    parserVersion: Number(item?.parserVersion || item?.parser_version || 0),
    releaseId: (item?.releaseId || item?.release_id || "").toString(),
    scriptSource: (item?.scriptSource || item?.script_source || "").toString(),
    scriptSha256: (item?.scriptSha256 || item?.script_sha256 || "").toString(),
    durationMs: Number(item?.durationMs || item?.duration_ms || 0),
    success: item?.success === true,
    resultCount: Number(item?.resultCount || item?.result_count || 0),
    failureType: normalizeParseFailureType(item?.failureType || item?.failure_type || ""),
    safeErrorCode: (item?.safeErrorCode || item?.safe_error_code || "").toString(),
    schemaValid: item?.schemaValid === true || item?.schema_valid === true,
    confidence: Number(item?.confidence || 0)
  };
}

async function upsertRepairIssue({ session, pageFingerprint, attempt, finalFailureType, parseSessionId }) {
  const failureType = normalizeParseFailureType(attempt.failureType || finalFailureType || "unknown");
  const issueKey = [
    session.schoolSystemType || "unknown",
    session.sourceUrlHost || "unknown",
    session.pageFingerprintHash || hashText(JSON.stringify(pageFingerprint || {})),
    attempt.parserName || "unknown.js",
    attempt.parserVersion || 0,
    failureType
  ].join("|");
  const issueId = `issue_${hashText(issueKey).slice(0, 16)}`;
  const key = buildRepairIssueKey(issueId);
  const previousRaw = await redisClient.get(key);
  const previous = previousRaw ? safeJson(previousRaw) : null;
  const now = Date.now();
  const issue = {
    issueId,
    issueKey,
    schoolId: session.schoolId || "",
    schoolName: session.schoolName || "",
    schoolSystemType: session.schoolSystemType || "unknown",
    sourceUrlHost: session.sourceUrlHost || "",
    pageFingerprintHash: session.pageFingerprintHash || "",
    affectedScriptId: attempt.parserName || "",
    affectedVersion: Number(attempt.parserVersion || 0),
    failureType,
    sampleCount: Number(previous?.sampleCount || 0),
    userCount: Number(previous?.userCount || 0),
    priority: previous?.priority || "P2",
    status: previous?.status || "open",
    lastParseSessionId: parseSessionId,
    lastAttempt: attempt,
    createdAt: Number(previous?.createdAt || now),
    updatedAt: now,
    lastSeenAt: now
  };
  await redisClient.sAdd("repair:issue:ids", issueId);
  const seenKey = buildRepairIssueSessionsKey(issueId);
  const added = await redisClient.sAdd(seenKey, parseSessionId);
  await redisClient.expire(seenKey, Math.ceil(queueItemTtlMs / 1000));
  if (added) issue.userCount += 1;
  await redisClient.set(key, JSON.stringify(issue));
  return issue;
}

async function saveFailureSample(issueId, sample) {
  const sampleId = `sample_${hashText(`${issueId}:${sample.parseSessionId}:${sample.contentSha256}`).slice(0, 16)}`;
  await redisClient.set(buildFailureSampleKey(sampleId), JSON.stringify({ sampleId, issueId, ...sample }), {
    PX: queueItemTtlMs
  });
  await redisClient.sAdd(buildRepairIssueSamplesKey(issueId), sampleId);
  const issueRaw = await redisClient.get(buildRepairIssueKey(issueId));
  const issue = issueRaw ? safeJson(issueRaw) : null;
  if (issue) {
    issue.sampleCount = Number(issue.sampleCount || 0) + 1;
    issue.updatedAt = Date.now();
    await redisClient.set(buildRepairIssueKey(issueId), JSON.stringify(issue));
  }
}

async function listRepairIssues(limit = 100) {
  if (!redisReady) return [];
  const ids = await redisClient.sMembers("repair:issue:ids");
  const items = [];
  for (const issueId of ids) {
    const raw = await redisClient.get(buildRepairIssueKey(issueId));
    const issue = raw ? safeJson(raw) : null;
    if (issue) items.push(issue);
  }
  return items.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).slice(0, limit);
}

async function getRepairIssueDetail(issueId) {
  const raw = await redisClient.get(buildRepairIssueKey(issueId));
  const issue = raw ? safeJson(raw) : null;
  if (!issue) return null;
  const sampleIds = await redisClient.sMembers(buildRepairIssueSamplesKey(issueId));
  const samples = [];
  for (const sampleId of sampleIds.slice(0, 20)) {
    const sampleRaw = await redisClient.get(buildFailureSampleKey(sampleId));
    const sample = sampleRaw ? safeJson(sampleRaw) : null;
    if (sample) {
      samples.push({
        ...sample,
        contentPreview: (sample.content || "").toString().slice(0, 4000)
      });
    }
  }
  const attempts = issue.lastParseSessionId ? await readParserAttempts(issue.lastParseSessionId) : [];
  return { issue, samples, attempts };
}

async function readParserAttempts(parseSessionId) {
  const list = await redisClient.lRange(buildParserAttemptsKey(parseSessionId), 0, 50);
  return list.map((item) => safeJson(item)).filter(Boolean);
}

async function runRepairIssueTest(issueId, username) {
  const detail = await getRepairIssueDetail(issueId);
  if (!detail) return { ok: false, code: 404, reason: "issue_not_found" };
  const scriptName = detail.issue?.affectedScriptId || "";
  const script = await readScript(scriptName);
  if (!script) return { ok: false, code: 404, reason: "script_not_found" };
  const submissions = detail.samples
    .filter((item) => item.content)
    .map((item) => ({ content: item.content, hash: item.contentSha256 || item.sampleId }));
  if (submissions.length === 0) return { ok: false, code: 400, reason: "sample_not_found" };
  const replay = runSubmissionReplay(script, submissions);
  const result = {
    ok: replay.ok,
    reason: replay.reason || "",
    testedAt: Date.now(),
    testedBy: username,
    sampleCount: submissions.length
  };
  const issueRaw = await redisClient.get(buildRepairIssueKey(issueId));
  const issue = issueRaw ? safeJson(issueRaw) : null;
  if (issue) {
    issue.lastReplay = result;
    issue.updatedAt = Date.now();
    await redisClient.set(buildRepairIssueKey(issueId), JSON.stringify(issue));
  }
  return result;
}

function normalizeReportSchoolSystemType(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (raw === "zf" || raw === "zhengfang") return "zhengfang";
  if (raw === "qiangzhi") return "qiangzhi";
  if (raw === "kingosoft") return "kingosoft";
  if (raw === "qidi") return "qidi";
  if (raw === "chaoxing") return "chaoxing";
  return raw || "unknown";
}

function normalizeParseFailureType(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  const map = {
    parser_empty_result: "parser_empty",
    script_execution_exception: "parser_crash",
    unsupported_page: "unsupported_format",
    page_not_loaded: "extractor_empty",
    unknown: "unknown"
  };
  return map[raw] || raw || "unknown";
}

function buildParseSessionKey(parseSessionId) {
  return `parse:session:${parseSessionId}`;
}

function buildParserAttemptsKey(parseSessionId) {
  return `parser:attempts:${parseSessionId}`;
}

function buildRepairIssueKey(issueId) {
  return `repair:issue:${issueId}`;
}

function buildRepairIssueSessionsKey(issueId) {
  return `repair:issue:sessions:${issueId}`;
}

function buildRepairIssueSamplesKey(issueId) {
  return `repair:issue:samples:${issueId}`;
}

function buildFailureSampleKey(sampleId) {
  return `failure:sample:${sampleId}`;
}

/**
 * 将提交内容加入学校队列
 */
/**
 * 将用户提交的原始教务内容入队
 * 入队后会记录当前时间，以便后续按时间窗口进行聚类处理
 */
async function enqueueSchoolSubmission(schoolId, content, scriptName, schoolInfo) {
  const now = Date.now();
  const contentHash = hashText(content);
  const dedupKey = buildDedupKey(schoolId, contentHash);
  const deduped = await redisClient.set(dedupKey, "1", { NX: true, PX: dedupWindowMs });
  if (!deduped) return;
  const item = {
    content,
    scriptName,
    createdAt: now,
    hash: contentHash,
    schoolName: schoolInfo?.schoolName || "",
    schoolSystemType: schoolInfo?.schoolSystemType || "unknown",
    sourceUrl: schoolInfo?.sourceUrl || "",
    scriptVersion: Number(schoolInfo?.scriptVersion || 0),
    scriptSource: (schoolInfo?.scriptSource || "").toString(),
    failureType: (schoolInfo?.failureType || "").toString(),
    classifiedFailureType: (schoolInfo?.classifiedFailureType || "").toString(),
    failureCategory: (schoolInfo?.failureCategory || "").toString(),
    failureSource: (schoolInfo?.failureSource || "").toString(),
    schoolSystemSource: (schoolInfo?.schoolSystemSource || "").toString(),
    clientVersion: (schoolInfo?.clientVersion || "").toString(),
    parseSessionId: (schoolInfo?.parseSessionId || "").toString(),
    attemptedParsers: Array.isArray(schoolInfo?.attemptedParsers)
      ? schoolInfo.attemptedParsers.map((item) => sanitizeScriptName(item)).filter(Boolean).slice(0, 12)
      : [],
    candidateUrls: Array.isArray(schoolInfo?.candidateUrls) ? schoolInfo.candidateUrls.slice(0, 12) : []
  };
  const queueKey = buildQueueKey(schoolId);
  try {
    // 记录出现过的学校，用于运维面板汇总展示
    await redisClient.sAdd("school:ids", schoolId);
    await redisClient.rPush(queueKey, JSON.stringify(item));
    await redisClient.lTrim(queueKey, -maxQueueSize, -1);
    await redisClient.expire(queueKey, Math.ceil(queueItemTtlMs / 1000));
    await setSchoolPhase(schoolId, "WAITING_WINDOW");
  } catch (error) {
    console.error("enqueue error:", error);
  }
  scheduleSchoolProcessing(schoolId);
}

function isParseProviderReady() {
  if (provider === "gemini") {
    return Boolean(apiKey);
  }
  return Boolean(apiKey);
}

function buildPendingParseKey() {
  return "parse:pending";
}

async function enqueuePendingParseTask(payload) {
  if (!redisReady) return;
  await redisClient.rPush(buildPendingParseKey(), JSON.stringify(payload || {}));
  await redisClient.lTrim(buildPendingParseKey(), -1000, -1);
}

function schedulePendingParseProcessing() {
  if (!redisReady) return;
  if (pendingParseTimer) return;
  const run = async () => {
    if (!isParseProviderReady()) return;
    let processed = 0;
    while (processed < 20) {
      const raw = await redisClient.lPop(buildPendingParseKey());
      if (!raw) break;
      const item = safeJson(raw) || {};
      const taskId = (item?.taskId || "").toString();
      const content = (item?.content || "").toString();
      const schoolId = (item?.schoolId || "").toString();
      if (!taskId || !content) {
        processed += 1;
        continue;
      }
      const existing = (await getTask(taskId)) || {};
      await saveTask(taskId, {
        ...existing,
        status: "PROCESSING",
        pendingReason: "",
        startedAt: Date.now(),
        createdAt: existing.createdAt || Date.now()
      });
      await runTask(taskId, content, schoolId).catch(async () => {
        const existing = (await getTask(taskId)) || {};
        await saveTask(taskId, {
          ...existing,
          status: "FAILED",
          result: null,
          reason: "pending_parse_run_failed",
          createdAt: existing.createdAt || Date.now()
        });
      });
      processed += 1;
    }
  };
  pendingParseTimer = setInterval(() => {
    run().catch(() => {});
  }, pendingParseRetryMs);
  run().catch(() => {});
}

/**
 * 调度学校维度的脚本修复流程
 * 将学校 ID 放入待处理集合 pendingSchools 中，并触发 drainSchoolProcessing 进行消费
 */
function scheduleSchoolProcessing(schoolId) {
  if (!schoolId) return;
  if (schoolProcessing.get(schoolId)) return;
  pendingSchools.add(schoolId);
  drainSchoolProcessing();
}

/**
 * 控制并发并消费 pendingSchools 集合
 * 确保同时进行脚本修复的学校数不超过 maxSchoolConcurrency，平滑高负载
 */
function drainSchoolProcessing() {
  if (activeSchoolProcessing >= maxSchoolConcurrency) return;
  if (pendingSchools.size === 0) return;
  while (activeSchoolProcessing < maxSchoolConcurrency && pendingSchools.size > 0) {
    const iterator = pendingSchools.values();
    const schoolId = iterator.next().value;
    if (!schoolId) break;
    pendingSchools.delete(schoolId);
    schoolProcessing.set(schoolId, true);
    activeSchoolProcessing += 1;
    setTimeout(async () => {
      try {
        await processSchoolQueue(schoolId);
      } finally {
        schoolProcessing.set(schoolId, false);
        activeSchoolProcessing = Math.max(0, activeSchoolProcessing - 1);
        drainSchoolProcessing();
      }
    }, processDelayMs);
  }
}

/**
 * 学校维度队列处理核心逻辑
 * 1. 获取分布式锁，防止并发处理同一学校的队列
 * 2. 剪枝并过滤出在有效合并窗口（mergeWindowMs）内的提交
 * 3. 语义聚类：将问题标准化后按类别和相似度进行分组，避免不相关的问题混在一起导致 LLM 总结污染
 * 4. 遍历聚类簇，逐个调用 LLM 总结与修复脚本
 */
async function processSchoolQueue(schoolId) {
  const lockKey = buildSchoolLockKey(schoolId);
  const lockToken = crypto.randomUUID();
  const lease = await acquireSchoolLease(lockKey, lockToken, schoolLockTtlMs);
  if (!lease.acquired) return;
  try {
    const queue = await getSchoolQueue(schoolId);
    const prunedQueue = await pruneQueueIfNeeded(schoolId, queue);
    if (prunedQueue.length < minQueueSize) return;
    const now = Date.now();
    const effectiveMergeWindowMs =
      pendingSchools.size >= backpressurePendingThreshold ? backpressureMergeWindowMs : mergeWindowMs;
    const recentQueue = prunedQueue.filter((item) => now - item.createdAt <= effectiveMergeWindowMs);
    if (recentQueue.length < minQueueSize) return;
    let state = (await getSchoolState(schoolId)) || {
      lastSummaryHash: "",
      lastScriptHash: "",
      lastUpdatedAt: 0
    };
    const normalizedIssues = await normalizeIssueBatch(recentQueue, schoolId);
    const clusters = buildSemanticClusters(recentQueue, normalizedIssues, issueClusterSimilarity);
    let appliedAny = false;
    for (const cluster of clusters) {
      const items = cluster.map((entry) => entry.item);
      const issues = cluster.map((entry) => entry.normalized);
      if (!items || items.length < minQueueSize) continue;
      const result = await processQueueCluster(schoolId, items, issues, state, now);
      if (result?.state) {
        state = result.state;
      }
      if (result?.applied) {
        appliedAny = true;
      }
      if (result?.failed) {
        await setSchoolPhase(schoolId, "FAILED_RETRYING");
        return;
      }
    }
    if (!appliedAny) return;
    await clearSchoolQueue(schoolId);
    await setSchoolPhase(schoolId, "IDLE");
  } finally {
    await releaseSchoolLease(lockKey, lockToken, lease.renewTimer);
  }
}

/**
 * 处理单个问题聚类簇
 * - 冲突检测：如果存在互相冲突的问题（如既有“登录成功”又有“登录失败”），则降级为单条处理。
 * - LLM 总结（模型 1）：提取出多条相似提交的共同结构和特征。
 * - 修复指令生成（模型 1）：将总结转化为具体的脚本修复动作要点。
 * - 脚本修复（模型 2）：高成本模型基于原脚本和修复指令生成新脚本。
 */
async function processQueueCluster(schoolId, items, normalizedIssues, state, now) {
  await setSchoolPhase(schoolId, "MERGING");
  if (shouldDegradeHighCost()) {
    await setSchoolPhase(schoolId, "WAITING_WINDOW");
    return { state, applied: false, deferred: true };
  }
  const hasConflict = detectConflict(normalizedIssues);
  if (hasConflict) {
    await setSchoolPhase(schoolId, "REPAIRING");
    await processIndividualSummaries(schoolId, items);
    const refreshed = (await getSchoolState(schoolId)) || state;
    return { state: refreshed, applied: true };
  }
  const mergedText = items.map((item, index) => `【提交 ${index + 1}】\n${item.content}`).join("\n");
  const summary = await summarizeSubmissions(mergedText, schoolId);
  if (!summary) return { state, applied: false };
  const patchGuidance = await generatePatchGuidance(summary, schoolId);
  const summaryHash = hashText(summary);
  const issueCategories = Array.from(
    new Set((normalizedIssues || []).map((item) => (item?.category || "").toString()).filter(Boolean))
  );
  const context = {
    mode: "cluster",
    clusterSize: Array.isArray(items) ? items.length : 0,
    issueCategories,
    summaryHash,
    guidanceHash: patchGuidance ? hashText(patchGuidance) : "",
    guidancePreview: (patchGuidance || "").toString().slice(0, 300)
  };
  const shouldProcessIndividually =
    state.lastUpdatedAt > 0 && now - state.lastUpdatedAt <= reprocessWindowMs && summaryHash !== state.lastSummaryHash;
  if (shouldProcessIndividually) {
    await setSchoolPhase(schoolId, "REPAIRING");
    await processIndividualSummaries(schoolId, items);
    const refreshed = (await getSchoolState(schoolId)) || state;
    return { state: refreshed, applied: true };
  }
  const scriptName = resolveScriptName(schoolId, items);
  const previousScript = await readScript(scriptName);
  const previousMeta = await getScriptMeta(scriptName);
  await setSchoolPhase(schoolId, "REPAIRING");
  const generatedScript = await generateParserScript(summary, patchGuidance, previousScript, schoolId);
  if (!generatedScript) return { state, applied: false };
  const submissionReplay = runSubmissionReplay(generatedScript, items);
  if (!submissionReplay.ok) {
    await recordScriptFailure(
      scriptName,
      submissionReplay.reason || "提交回放失败",
      "submission_replay",
      schoolId,
      {
        stage: "REPAIRING",
        retryable: true,
        scriptVersion: previousMeta?.version || 0
      }
    );
    return { state, failed: true };
  }
  await setSchoolPhase(schoolId, "APPLYING");
  const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript, {
    schoolId,
    previousMeta,
    context,
    releaseStage: "pending",
    actionType: "auto_repair"
  });
  if (applyResult.pending) {
    return { state, applied: false };
  }
  if (!applyResult.ok) {
    await recordScriptFailure(
      scriptName,
      applyResult.reason || "脚本校验失败",
      applyResult.failureType || "unknown",
      schoolId,
      {
        stage: "APPLYING",
        retryable: false,
        scriptVersion: previousMeta?.version || 0
      }
    );
    return { state, failed: true };
  }
  const nextState = {
    lastSummaryHash: summaryHash,
    lastScriptHash: hashText(generatedScript),
    lastUpdatedAt: now
  };
  await setSchoolState(schoolId, nextState);
  return { state: nextState, applied: true };
}

/**
 * 对每条提交逐条总结后再修复脚本
 */
/**
 * 处理单条记录的降级方法（兜底流程）
 * 当无法聚类或存在严重冲突时，放弃汇总，直接针对单条用户的错误进行针对性修复
 */
async function processIndividualSummaries(schoolId, queue) {
  const summaries = [];
  for (const item of queue) {
    const summary = await summarizeSubmissions(item.content, schoolId);
    if (summary) summaries.push(summary);
  }
  if (summaries.length === 0) return;
  const mergedSummary = summaries.map((text, index) => `【总结 ${index + 1}】\n${text}`).join("\n");
  const scriptName = resolveScriptName(schoolId, queue);
  const previousScript = await readScript(scriptName);
  const previousMeta = await getScriptMeta(scriptName);
  const patchGuidance = await generatePatchGuidance(mergedSummary, schoolId);
  const generatedScript = await generateParserScript(mergedSummary, patchGuidance, previousScript, schoolId);
  if (!generatedScript) return;
  const submissionReplay = runSubmissionReplay(generatedScript, queue);
  if (!submissionReplay.ok) {
    await recordScriptFailure(
      scriptName,
      submissionReplay.reason || "提交回放失败",
      "submission_replay",
      schoolId,
      {
        stage: "REPAIRING",
        retryable: true,
        scriptVersion: previousMeta?.version || 0
      }
    );
    return;
  }
  const context = {
    mode: "single",
    clusterSize: Array.isArray(queue) ? queue.length : 0,
    issueCategories: [],
    summaryHash: hashText(mergedSummary),
    guidanceHash: patchGuidance ? hashText(patchGuidance) : "",
    guidancePreview: (patchGuidance || "").toString().slice(0, 300)
  };
  const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript, {
    schoolId,
    previousMeta,
    context,
    releaseStage: "pending",
    actionType: "auto_repair"
  });
  if (applyResult.pending) return;
  if (!applyResult.ok) {
    await recordScriptFailure(
      scriptName,
      applyResult.reason || "脚本校验失败",
      applyResult.failureType || "unknown",
      schoolId,
      {
        stage: "APPLYING",
        retryable: false,
        scriptVersion: previousMeta?.version || 0
      }
    );
    return;
  }
  await setSchoolState(schoolId, {
    lastSummaryHash: hashText(mergedSummary),
    lastScriptHash: hashText(generatedScript),
    lastUpdatedAt: Date.now()
  });
}

/**
 * 执行异步解析任务
 *
 * @param taskId 任务 ID
 * @param content 已脱敏文本
 */
/**
 * 通过模型调用构建解析任务的核心执行流程
 * 仅用于单次即时解析请求（兜底解析），不参与全局脚本修复的聚合与写回
 */
async function runTask(taskId, content, schoolId) {
  const startTime = Date.now();
  const parseResult = await callProvider(content);
  const resultText = parseResult?.resultText || null;
  const latencyMs = Date.now() - startTime;
  const existing = await getTask(taskId);
  const createdAt = existing?.createdAt || Date.now();
  const startedAt = existing?.startedAt || Date.now();
  const baseTask = {
    schoolId: existing?.schoolId || schoolId || "",
    schoolName: existing?.schoolName || "",
    schoolSystemType: existing?.schoolSystemType || "unknown",
    sourceUrl: existing?.sourceUrl || "",
    scriptName: existing?.scriptName || "",
    scriptVersion: Number(existing?.scriptVersion || 0),
    scriptSource: existing?.scriptSource || "",
    failureType: existing?.failureType || "",
    classifiedFailureType: existing?.classifiedFailureType || "",
    failureCategory: existing?.failureCategory || "",
    failureSource: existing?.failureSource || "",
    schoolSystemSource: existing?.schoolSystemSource || "",
    clientVersion: existing?.clientVersion || "",
    parseSessionId: existing?.parseSessionId || "",
    attemptedParsers: Array.isArray(existing?.attemptedParsers) ? existing.attemptedParsers : [],
    startedAt,
    pendingReason: ""
  };
  if (!resultText) {
    await saveTask(taskId, {
      ...baseTask,
      status: "FAILED",
      result: null,
      createdAt,
      completedAt: Date.now(),
      attempts: parseResult?.attempts || 0,
      reason: parseResult?.reason || "模型输出不可解析"
    });
    await recordMetric("parse_failed", latencyMs, parseCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "parse_failed", latencyMs, parseCostPerCall);
    }
    return;
  }
  await saveTask(taskId, {
    ...baseTask,
    status: "SUCCESS",
    result: resultText,
    createdAt,
    completedAt: Date.now(),
    attempts: parseResult?.attempts || 1,
    strategy: parseResult?.strategy || "standard"
  });
  if (isEmptyResult(resultText)) {
    await recordMetric("parse_empty", latencyMs, parseCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "parse_empty", latencyMs, parseCostPerCall);
    }
  } else {
    await recordMetric("parse_success", latencyMs, parseCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "parse_success", latencyMs, parseCostPerCall);
    }
  }
}

/**
 * 调用模型提供方并返回 ParsedCourse JSON 数组文本
 *
 * @param content 已脱敏文本
 */
async function callProvider(content) {
  const strategies = ["standard", "strict", "repair"];
  const maxAttempts = Math.min(parseMaxAttempts, strategies.length);
  const failedReasons = [];
  for (let i = 0; i < maxAttempts; i++) {
    const strategy = strategies[i];
    const attempt = await callProviderOnce(content, strategy);
    if (attempt.resultText) {
      return { resultText: attempt.resultText, attempts: i + 1, strategy };
    }
    failedReasons.push(attempt.reason || "unknown");
  }
  return {
    resultText: null,
    attempts: maxAttempts,
    strategy: "failed",
    reason: failedReasons.join(" | ")
  };
}

/**
 * 调用模型执行单次兜底解析
 * - standard：常规提取
 * - strict：加强字段和类型约束
 * - repair：要求先纠正坏格式再输出最终 JSON
 */
async function callProviderOnce(content, strategy) {
  const promptSet = buildParsePrompts(content, strategy);
  const rawText =
    provider === "gemini"
      ? await callGemini(promptSet.systemPrompt, promptSet.userPrompt, {
          usageType: "summary",
          extra: summaryRequestExtra
        })
      : await callOpenAICompatible(promptSet.systemPrompt, promptSet.userPrompt, {
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        });
  const extracted = extractJsonArray(rawText?.text || "");
  if (!extracted) {
    return { resultText: null, reason: `${strategy}: empty_or_invalid_json` };
  }
  return { resultText: extracted, reason: "" };
}

/**
 * 构建即时兜底解析提示词
 */
function buildParsePrompts(content, strategy) {
  const baseSystem =
    "你是课程表解析助手，只输出严格 JSON 数组，不要包含任何解释、Markdown、代码块。" +
    "数组元素必须符合 ParsedCourse 结构：" +
    "name,teacher,location,dayOfWeek,startSection,duration,startWeek,endWeek,weekType。";
  if (strategy === "strict") {
    return {
      systemPrompt:
        baseSystem +
        "必须进行字段类型纠正：dayOfWeek 限制 1-7，startSection/duration/startWeek/endWeek 必须是整数，weekType 必须是 0/1/2。",
      userPrompt:
        "请严格提取并纠正字段类型，仅输出 JSON 数组。" +
        "若信息缺失，teacher/location 可为空字符串，其余核心字段必须可用。\n" +
        `课表内容如下：\n${content}\n只输出 JSON 数组。`
    };
  }
  if (strategy === "repair") {
    return {
      systemPrompt:
        baseSystem +
        "当原文混乱时，先在内部修复字段，再输出最终 JSON 数组。禁止输出中间过程，禁止输出非 JSON。",
      userPrompt:
        "请执行“修复后提取”：合并同一课程重复行、修正周次/节次格式、补全可推断字段，最后仅输出 JSON 数组。\n" +
        `课表内容如下：\n${content}\n只输出 JSON 数组。`
    };
  }
  return {
    systemPrompt: baseSystem + "所有字段必须齐全，整数必须是数字类型。",
    userPrompt:
      "请从以下内容中提取课程信息，输出 JSON 数组，示例格式：" +
      "[{\"name\":\"高等数学\",\"teacher\":\"李四\",\"location\":\"A-301\",\"dayOfWeek\":1," +
      "\"startSection\":1,\"duration\":2,\"startWeek\":1,\"endWeek\":16,\"weekType\":0}]\n" +
      `课表内容如下：\n${content}\n只输出 JSON 数组。`
  };
}

/**
 * OpenAI 兼容接口调用（包括 DeepSeek/Qwen/GLM/GPT 等），返回原始文本及用量信息
 * 支持自动适配 Chat Completions (/v1/chat/completions) 和 Responses API (/v1/responses)
 */
async function callOpenAICompatible(systemPrompt, userPrompt, options = {}) {
  const requestProvider = (options.provider || provider).toLowerCase();
  const requestApiKey = options.apiKey || apiKey;
  const requestModel = resolveModelName(options.model || model);
  const requestBaseUrl = options.baseUrl || baseUrl;
  if (!requestApiKey) return null;
  const apiStyle =
    normalizeApiStyle(options.apiStyle) || resolveApiStyle(requestProvider, requestModel);
  const endpoint =
    apiStyle === "responses"
      ? `${requestBaseUrl}/v1/responses`
      : `${requestBaseUrl}${openAiPath(requestProvider)}`;
  const baseBody =
    apiStyle === "responses"
      ? {
          model: requestModel,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0
        }
      : {
          model: requestModel,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        };
  const body = mergeRequestExtras(baseBody, options.extra);
  const responseText = await httpPostJson(endpoint, body, {
    Authorization: `Bearer ${requestApiKey}`
  });
  if (!responseText) return null;
  const json = safeJson(responseText);
  const text =
    apiStyle === "responses" ? extractResponsesText(json) : json?.choices?.[0]?.message?.content || "";
  const usage = extractOpenAIUsage(json);
  if (options.usageType) {
    await recordLocalUsage(options.usageType, usage, requestProvider, requestModel);
  }
  return { text, usage, raw: json };
}

/**
 * Gemini 官方接口调用，返回原始文本及用量信息
 * 根据 Gemini 最佳实践，将系统提示词 (systemInstruction) 与用户提示词分离
 */
async function callGemini(systemPrompt, userPrompt, options = {}) {
  const requestApiKey = options.apiKey || apiKey;
  const requestModel = resolveModelName(options.model || model);
  const requestBaseUrl = options.baseUrl || baseUrl;
  if (!requestApiKey) return null;
  const endpoint = `${requestBaseUrl}/models/${requestModel}:generateContent?key=${requestApiKey}`;
  const baseBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: { temperature: 0 }
  };
  if (systemPrompt) {
    baseBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  const body = mergeRequestExtras(baseBody, options.extra);
  const responseText = await httpPostJson(endpoint, body, {});
  if (!responseText) return null;
  const json = safeJson(responseText);
  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ||
    json?.candidates?.[0]?.content?.text ||
    "";
  const usage = extractGeminiUsage(json);
  if (options.usageType) {
    await recordLocalUsage(options.usageType, usage, "gemini", requestModel);
  }
  return { text, usage, raw: json };
}

/**
 * 使用模型 1 对提交内容进行总结
 */
async function summarizeSubmissions(content, schoolId) {
  const systemPrompt =
    "你是课表解析总结助手，目标是提炼教务系统课表页面结构的关键信息。" +
    "输出为中文要点列表，不包含任何个人信息。";
  const userPrompt =
    "请总结以下多条提交内容的共同结构特征、字段含义、课程信息位置与可能的异常点。" +
    "输出格式为 6-12 条中文要点列表，每条不超过 30 字。\n" +
    `内容如下：\n${content}`;
  const startTime = Date.now();
  const rawText =
    summaryProvider === "gemini"
      ? await callGemini(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        })
      : await callOpenAICompatible(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText?.text) {
    await recordMetric("summary_failed", latencyMs, summaryCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "summary_failed", latencyMs, summaryCostPerCall);
    }
    return "";
  }
  await recordMetric("summary_success", latencyMs, summaryCostPerCall);
  if (schoolId) {
    await recordSchoolMetric(schoolId, "summary_success", latencyMs, summaryCostPerCall);
  }
  return rawText.text;
}

/**
 * 调用低成本模型 (模型 1) 批量标准化用户的反馈内容
 * 将杂乱的反馈结构化为带分类（category）、症状（symptom）、范围（scope）等字段的 JSON 数组
 * 用于后续的冲突检测和语义聚类
 */
async function normalizeIssueBatch(items, schoolId) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const payload = items.map((item, index) => ({
    index: index + 1,
    content: (item?.content || "").toString().slice(0, 2000),
    failureType: (item?.classifiedFailureType || item?.failureType || "").toString().slice(0, 80),
    scriptName: sanitizeScriptName(item?.scriptName || "").slice(0, 120),
    attemptedParsers: Array.isArray(item?.attemptedParsers)
      ? item.attemptedParsers.map((v) => sanitizeScriptName(v)).filter(Boolean).slice(0, 6)
      : [],
    schoolSystemType: normalizeSchoolSystemType(item?.schoolSystemType || ""),
    failureSource: (item?.failureSource || "").toString().slice(0, 40),
    schoolSystemSource: (item?.schoolSystemSource || "").toString().slice(0, 40)
  }));
  const systemPrompt =
    "你是问题标准化助手，需要把原始反馈转换为结构化 JSON 数组。" +
    "每项包含 index, category, symptom, scope, trigger, confidence。" +
    "category 仅允许：login_failed,login_success,timetable_empty,server_error,parse_error,other。";
  const userPrompt =
    "请基于以下多条内容输出 JSON 数组，不要包含任何额外说明。" +
    "可结合 failureType、scriptName、attemptedParsers、schoolSystemType 做更准确归类。\n" +
    `${JSON.stringify(payload)}`;
  const rawText =
    summaryProvider === "gemini"
      ? await callGemini(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        })
      : await callOpenAICompatible(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        });
  const rawTextContent = rawText?.text || "";
  const parsed = rawTextContent ? safeJson(rawTextContent) : null;
  if (!Array.isArray(parsed)) {
    return items.map((item, index) => ({
      index: index + 1,
      category: classifyIssueType(item?.content || ""),
      symptom: "",
      scope: "",
      trigger: "",
      confidence: 0.2
    }));
  }
  return parsed.map((item, index) => ({
    index: Number(item?.index || index + 1),
    category: item?.category || classifyIssueType(items[index]?.content || ""),
    symptom: item?.symptom || "",
    scope: item?.scope || "",
    trigger: item?.trigger || "",
    confidence: Number(item?.confidence || 0)
  }));
}

/**
 * 根据标准化后的问题列表进行冲突检测
 * 发现互斥问题时（如登录成功 vs 登录失败），阻止合并处理以防止 LLM 产生矛盾指令
 */
function detectConflict(normalizedIssues) {
  const categories = new Set(
    (normalizedIssues || []).map((item) => (item?.category || "").toString()).filter(Boolean)
  );
  if (categories.has("login_failed") && categories.has("login_success")) return true;
  if (categories.has("timetable_empty") && categories.has("parse_error")) return true;
  const symptoms = (normalizedIssues || []).map((item) => (item?.symptom || "").toString());
  const hasLoginSuccess = symptoms.some((text) => /登录成功|已登录|login success/i.test(text));
  const hasLoginFailed = symptoms.some((text) => /登录失败|账号|密码错误|验证码|login failed/i.test(text));
  if (hasLoginSuccess && hasLoginFailed) return true;
  return false;
}

/**
 * 调用低成本模型 (模型 1) 根据问题总结生成具体的修复指令
 * 明确告知高成本模型应该改什么，而不是让其自由发挥，降低幻觉概率
 */
async function generatePatchGuidance(summary, schoolId) {
  const systemPrompt =
    "你是修复指令生成器，需要把问题总结转成可执行的修复指令要点。" +
    "输出为中文要点列表，每条不超过 30 字。";
  const userPrompt =
    "请基于以下总结给出修复指令要点，避免泛泛而谈，尽量指向字段、结构或规则。\n" +
    `${summary}`;
  const startTime = Date.now();
  const rawText =
    summaryProvider === "gemini"
      ? await callGemini(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        })
      : await callOpenAICompatible(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText?.text) {
    await recordMetric("summary_failed", latencyMs, summaryCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "summary_failed", latencyMs, summaryCostPerCall);
    }
    return "";
  }
  await recordMetric("summary_success", latencyMs, summaryCostPerCall);
  if (schoolId) {
    await recordSchoolMetric(schoolId, "summary_success", latencyMs, summaryCostPerCall);
  }
  return rawText.text;
}

/**
 * 使用模型 2 生成或修复解析脚本
 */
/**
 * 调用高成本模型 (模型 2) 生成或修复解析脚本
 * 接收：结构总结、具体的修复指令、先前的脚本内容
 * 输出：可执行的 JavaScript 字符串
 */
async function generateParserScript(summary, patchGuidance, previousScript, schoolId) {
  const systemPrompt =
    "你是教务系统解析脚本工程师，输出必须是可直接运行的 JavaScript 解析脚本。" +
    "脚本运行环境为 QuickJS，无 DOM API，仅可使用字符串与正则。" +
    "禁止输出 Markdown 或多余说明。";
  const userPrompt =
    "请根据以下结构总结修复或生成解析脚本，要求输出完整 JS 脚本内容。" +
    "脚本必须返回 JSON 字符串，结构兼容 ParsedCourse 字段。" +
    "若提供旧脚本，请在其基础上修复，保留工具函数与已有规范。\n" +
    `【结构总结】\n${summary}\n` +
    `【修复指令】\n${patchGuidance || "无"}\n` +
    `【旧脚本】\n${previousScript || "无"}\n` +
    "请仅输出 JS 源码。";
  const startTime = Date.now();
  const rawText =
    scriptProvider === "gemini"
      ? await callGemini(systemPrompt, userPrompt, {
          provider: scriptProvider,
          apiKey: scriptApiKey,
          model: scriptModel,
          baseUrl: scriptBaseUrl,
          usageType: "script",
          extra: scriptRequestExtra,
          apiStyle: scriptApiStyleRaw
        })
      : await callOpenAICompatible(systemPrompt, userPrompt, {
          provider: scriptProvider,
          apiKey: scriptApiKey,
          model: scriptModel,
          baseUrl: scriptBaseUrl,
          usageType: "script",
          extra: scriptRequestExtra,
          apiStyle: scriptApiStyleRaw
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText?.text) {
    await recordMetric("script_failed", latencyMs, scriptCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "script_failed", latencyMs, scriptCostPerCall);
    }
    return "";
  }
  await recordMetric("script_success", latencyMs, scriptCostPerCall);
  if (schoolId) {
    await recordSchoolMetric(schoolId, "script_success", latencyMs, scriptCostPerCall);
  }
  return cleanScriptOutput(rawText.text);
}

/**
 * 解析脚本名
 */
function resolveScriptName(schoolId, queue) {
  const withName = queue.find((item) => item.scriptName);
  if (withName?.scriptName) return sanitizeScriptName(withName.scriptName);
  const withAttempted = queue.find((item) => Array.isArray(item.attemptedParsers) && item.attemptedParsers.length > 0);
  if (withAttempted?.attemptedParsers?.[0]) return sanitizeScriptName(withAttempted.attemptedParsers[0]);
  const systemTypeRaw = (queue.find((item) => item.schoolSystemType)?.schoolSystemType || "").toString();
  const normalizedSystemType =
    normalizeSchoolSystemType(systemTypeRaw) || detectSchoolSystemType((queue?.[0]?.content || "").toString());
  const mapped =
    normalizedSystemType === "zhengfang"
      ? "zhengfang.js"
      : normalizedSystemType === "qiangzhi"
        ? "qiangzhi.js"
        : normalizedSystemType === "kingosoft"
          ? "kingosoft.js"
          : "";
  if (mapped) return sanitizeScriptName(mapped);
  return sanitizeScriptName(`${schoolId}.js`);
}

/**
 * 读取已有脚本
 * - 优先读取新目录
 * - 读取失败时回退 legacy 目录
 * - 命中 legacy 后会自动迁移到新目录并尝试补齐 meta
 */
async function readScript(scriptName) {
  const fullPath = buildScriptPath(scriptName);
  const content = await readTextIfExists(fullPath);
  if (content != null) return content;
  const legacyPath = await findLegacyScriptPath(scriptName);
  if (!legacyPath) return "";
  const legacyContent = await readTextIfExists(legacyPath);
  if (legacyContent == null) return "";
  await migrateLegacyScript(scriptName, legacyPath, legacyContent);
  return legacyContent;
}

/**
 * 读取文本文件（不存在时返回 null）
 */
async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 判断文件是否存在
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 legacy 目录中寻找脚本路径
 */
async function findLegacyScriptPath(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  for (const legacyDir of legacyScriptOutputDirs) {
    const legacyPath = path.join(legacyDir, safeName);
    if (await fileExists(legacyPath)) return legacyPath;
  }
  return "";
}

/**
 * 迁移 legacy 脚本到新目录
 * - 确保新目录存在
 * - 仅在新目录缺失时才写入，避免覆盖现有脚本
 * - 如果 legacy meta 存在且新目录缺失，则同步迁移 meta
 */
async function migrateLegacyScript(scriptName, legacyPath, legacyContent) {
  const targetPath = buildScriptPath(scriptName);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (!(await fileExists(targetPath))) {
    await fs.writeFile(targetPath, legacyContent, "utf-8");
  }
  const legacyMetaPath = await findLegacyMetaPath(scriptName, legacyPath);
  if (!legacyMetaPath) return;
  const targetMetaPath = buildScriptMetaPath(scriptName);
  if (await fileExists(targetMetaPath)) return;
  const legacyMeta = await readTextIfExists(legacyMetaPath);
  if (!legacyMeta) return;
  await fs.mkdir(path.dirname(targetMetaPath), { recursive: true });
  await fs.writeFile(targetMetaPath, legacyMeta, "utf-8");
}

/**
 * 寻找 legacy 的 meta 路径
 * 先尝试脚本同目录，再遍历 legacy 目录列表兜底
 */
async function findLegacyMetaPath(scriptName, legacyScriptPath) {
  const legacyDir = legacyScriptPath ? path.dirname(legacyScriptPath) : "";
  const metaFileName = buildScriptMetaFileName(scriptName);
  if (legacyDir) {
    const metaPath = path.join(legacyDir, metaFileName);
    if (await fileExists(metaPath)) return metaPath;
  }
  for (const legacyDir of legacyScriptOutputDirs) {
    const metaPath = path.join(legacyDir, metaFileName);
    if (await fileExists(metaPath)) return metaPath;
  }
  return "";
}

/**
 * 确保脚本与指标目录存在，避免首次启动写入失败
 */
async function ensureStorageLayout() {
  await fs.mkdir(scriptOutputDir, { recursive: true });
  await fs.mkdir(scriptBackupDir, { recursive: true });
  await fs.mkdir(path.dirname(schoolMetricsFile), { recursive: true });
}

/**
 * 计算文本哈希
 */
function hashText(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

/**
 * 清理模型输出的脚本内容
 */
/**
 * 对提取出的脚本代码做二次清洗
 * 剥离 Markdown 代码块、去除开头的常量声明和不安全的前后缀
 */
function cleanScriptOutput(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    const startIndex = lines.findIndex((line) => line.trim().startsWith("```"));
    const endIndex = lines.findIndex(
      (line, index) => index > startIndex && line.trim().startsWith("```")
    );
    if (startIndex !== -1 && endIndex !== -1) {
      return lines.slice(startIndex + 1, endIndex).join("\n").trim();
    }
  }
  return trimmed;
}

function parseCommaSet(value) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

/**
 * 解析逗号分隔的列表
 * 用于读取目录列表或白名单配置
 */
function parseCommaList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 解析离线回放测试的数据集
 * 数据集为 JSON 格式，包含了特定的 HTML 页面内容和期望输出，用于上线前验证
 */
function parseOfflineReplayDataset(raw) {
  const data = raw ? safeJson(raw) : null;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => ({
      content: (item?.content || item?.input || "").toString(),
      expectedMinCount: Number(item?.expectedMinCount || item?.minCount || 0),
      expectedFields: Array.isArray(item?.expectedFields) ? item.expectedFields : [],
      expectEmpty: Boolean(item?.expectEmpty)
    }))
    .filter((item) => item.content);
}

/**
 * 判断是否触发高成本模型降级
 * 在极端负载下，关闭脚本生成，仅将问题堆积到等待队列中
 */
function shouldDegradeHighCost() {
  if (!degradeHighCostEnabled) return false;
  if (activeSchoolProcessing >= maxSchoolConcurrency) return true;
  if (pendingSchools.size >= backpressurePendingThreshold) return true;
  return false;
}

function shouldCanaryRelease(schoolId) {
  if (canarySchoolSet.has(schoolId)) return true;
  if (canaryPercent <= 0) return false;
  const hash = hashText(schoolId);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < canaryPercent;
}

/**
 * 统一发布阶段枚举
 */
function normalizeReleaseStage(stage) {
  const raw = (stage || "").toString().trim().toLowerCase();
  if (!raw) return "active";
  if (raw === "active" || raw === "full") return "active";
  if (raw === "canary" || raw === "gradual" || raw === "staged") return "canary";
  if (raw === "pending") return "pending";
  if (raw === "rollback") return "rollback";
  return "active";
}

/**
 * 生成发布二次确认令牌
 * 令牌绑定脚本名、目标阶段和 pending 内容摘要，避免误操作串用
 */
function buildPublishConfirmToken(scriptName, releaseStage, pendingContent) {
  const contentHash = hashText((pendingContent || "").toString()).slice(0, 16);
  return hashText(`${sanitizeScriptName(scriptName)}:${normalizeReleaseStage(releaseStage)}:${contentHash}`);
}

/**
 * 决定新修复脚本的发布阶段（全量/灰度/挂起）
 * - 如果明确指定或通过强制参数 (forceRelease)，直接全量发布
 * - 命中灰度名单或哈希桶 (canaryPercent)，进入 canary 阶段
 * - 否则进入 pending 阶段，等待人工确认或自动晋升
 */
function decideReleaseStage(schoolId, forceRelease, explicitStage) {
  const normalizedExplicit = normalizeReleaseStage(explicitStage);
  if (explicitStage) return normalizedExplicit;
  if (forceRelease) return "active";
  if (canaryPercent <= 0 && canarySchoolSet.size === 0) return "active";
  return shouldCanaryRelease(schoolId) ? "canary" : "pending";
}

function buildPendingScriptKey(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:pending:${safeName}`;
}

async function savePendingScript(scriptName, content) {
  if (!redisReady) return;
  await redisClient.set(buildPendingScriptKey(scriptName), content, { PX: backupTtlMs });
}

async function loadPendingScript(scriptName) {
  if (!redisReady) return "";
  return await redisClient.get(buildPendingScriptKey(scriptName));
}

async function clearPendingScript(scriptName) {
  if (!redisReady) return;
  await redisClient.del(buildPendingScriptKey(scriptName));
}

function buildScriptBackupKey(scriptName, version) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:backup:${safeName}:${version}`;
}

async function saveScriptBackup(scriptName, version, content) {
  if (!content) return;
  if (redisReady) {
    const key = buildScriptBackupKey(scriptName, version);
    await redisClient.set(key, content, { PX: backupTtlMs });
  }
  await writeBackupScript(scriptName, version, content);
}

async function loadScriptBackup(scriptName, version) {
  if (!version) return "";
  if (redisReady) {
    const key = buildScriptBackupKey(scriptName, version);
    const cached = (await redisClient.get(key)) || "";
    if (cached) return cached;
  }
  return await readBackupScript(scriptName, version);
}

/**
 * 运行离线回放测试
 * 使用本地挂载的样本数据集，对生成的脚本执行真实输入并断言输出结果
 * 阻止因幻觉导致的大面积空白课表等破坏性更新
 */
async function runOfflineReplay(scriptContent) {
  if (!offlineReplayDataset.length) {
    return offlineReplayRequired ? { ok: false, reason: "离线回放数据缺失" } : { ok: true };
  }
  for (const sample of offlineReplayDataset) {
    const output = executeScriptWithContent(scriptContent, sample.content);
    const parsed = parseScriptExecutionOutput(output);
    if (parsed == null) {
      return { ok: false, reason: "离线回放执行失败" };
    }
    if (sample.expectEmpty && parsed.length > 0) {
      return { ok: false, reason: "离线回放期望为空" };
    }
    if (!sample.expectEmpty && sample.expectedMinCount > 0 && parsed.length < sample.expectedMinCount) {
      return { ok: false, reason: "离线回放结果数量不足" };
    }
    if (sample.expectedFields.length > 0 && parsed.length > 0) {
      const first = parsed[0] || {};
      const missing = sample.expectedFields.filter((field) => first[field] == null);
      if (missing.length > 0) {
        return { ok: false, reason: "离线回放缺少字段" };
      }
    }
  }
  return { ok: true };
}

/**
 * 使用当前批次提交数据进行回放验证
 * 自动修复后先验证“本次真实提交”可解析，再进入正式校验和发布决策
 */
function runSubmissionReplay(scriptContent, submissions) {
  const samples = (Array.isArray(submissions) ? submissions : [])
    .filter((item) => item && typeof item.content === "string" && item.content.trim().length > 0)
    .slice(0, 12);
  if (!samples.length) {
    return { ok: false, reason: "提交回放样本为空" };
  }
  let nonEmptyCount = 0;
  let validCourseCount = 0;
  for (const sample of samples) {
    const parsed = parseScriptExecutionOutput(executeScriptWithContent(scriptContent, sample.content));
    if (parsed == null) {
      return { ok: false, reason: "提交回放执行失败" };
    }
    if (parsed.length > 0) {
      nonEmptyCount += 1;
      let sampleHasValidCourse = false;
      for (const course of parsed) {
        const check = validateReplayCourse(course);
        if (check.ok) {
          sampleHasValidCourse = true;
          validCourseCount += 1;
          break;
        }
      }
      if (!sampleHasValidCourse) {
        return { ok: false, reason: "提交回放关键字段非法" };
      }
    }
  }
  if (nonEmptyCount <= 0) {
    return { ok: false, reason: "提交回放结果均为空" };
  }
  if (validCourseCount <= 0) {
    return { ok: false, reason: "提交回放无有效课程" };
  }
  return { ok: true };
}

function validateReplayCourse(course) {
  if (!course || typeof course !== "object") return { ok: false, reason: "course_not_object" };
  const requiredTextFields = ["name", "weekType"];
  const missingText = requiredTextFields.some((field) => {
    const value = (course[field] ?? "").toString().trim();
    return !value;
  });
  if (missingText) return { ok: false, reason: "missing_text_field" };
  const dayOfWeek = toPositiveInt(course.dayOfWeek);
  const startSection = toPositiveInt(course.startSection);
  const duration = toPositiveInt(course.duration);
  const startWeek = toPositiveInt(course.startWeek);
  const endWeek = toPositiveInt(course.endWeek);
  if (!dayOfWeek || dayOfWeek < 1 || dayOfWeek > 7) return { ok: false, reason: "invalid_day" };
  if (!startSection || startSection < 1 || startSection > 30) return { ok: false, reason: "invalid_start_section" };
  if (!duration || duration < 1 || duration > 12) return { ok: false, reason: "invalid_duration" };
  if (!startWeek || startWeek < 1 || startWeek > 40) return { ok: false, reason: "invalid_start_week" };
  if (!endWeek || endWeek < startWeek || endWeek > 40) return { ok: false, reason: "invalid_end_week" };
  return { ok: true };
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * 解析脚本执行结果为课程数组
 */
function parseScriptExecutionOutput(output) {
  if (output == null) return null;
  const parsed = typeof output === "string" ? safeJson(output) : output;
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 封装执行用户提供的或新生成的 JavaScript 脚本
 * 将环境模拟为类似端侧 QuickJS，并在沙盒内拦截执行结果
 * 支持全局变量赋值以及多种入口函数命名 (scheduleHtmlProvider, parseHtml 等)
 */
function executeScriptWithContent(scriptContent, content) {
  try {
    const runner = new Function(
      "content",
      `"use strict";let __result=null;let __dawnResult=null;let __dawnReady=false;${scriptContent}\n` +
        "if (typeof globalThis.__dawnResult !== 'undefined' && globalThis.__dawnResult !== null) return globalThis.__dawnResult;" +
        "if (typeof scheduleHtmlParser === 'function') return scheduleHtmlParser(content);" +
        "if (typeof scheduleHtmlProvider === 'function') return scheduleHtmlProvider(content);" +
        "if (typeof parseHtml === 'function') return parseHtml(content);" +
        "if (typeof parse === 'function') return parse(content);" +
        "if (typeof main === 'function') return main(content);" +
        "return __result;"
    );
    return runner(content);
  } catch {
    return null;
  }
}

/**
 * 应用脚本更新
 * 包含多重安全校验：
 * 1. 结构与语法校验 validateScriptStructure
 * 2. 离线回放测试 runOfflineReplay
 * 3. 内容去重校验（与旧脚本一致则跳过）
 * 4. 根据灰度策略写入不同的存储区域（待定区或正式区）
 * 5. 更新元数据并生成数字签名
 */
async function applyScriptUpdate(scriptName, content, previousContent, options = {}) {
  const validation = validateScriptStructure(content);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, failureType: "validation" };
  }
  const replay = await runOfflineReplay(content);
  if (!replay.ok) {
    return { ok: false, reason: replay.reason || "离线回放失败", failureType: "replay" };
  }
  if (previousContent && hashText(previousContent) === hashText(content)) {
    const existingMeta = await getScriptMeta(scriptName);
    if (!existingMeta) {
      const meta = await buildScriptMeta(scriptName, content, {
        previousMeta: options.previousMeta,
        releaseStage: "active",
        appliedBy: options.appliedBy,
        context: options.context || null,
        validate: { ok: true },
        replay: { ok: true }
      });
      await writeScriptMeta(scriptName, meta);
    }
    await pushScriptHistory(scriptName, {
      type: "skipped",
      appliedBy: options.appliedBy || "auto-repair",
      schoolId: options.schoolId || "",
      releaseStage: "active",
      context: options.context || null,
      validate: { ok: true },
      replay: { ok: true }
    });
    return { ok: true, skipped: true };
  }
  const releaseStage = decideReleaseStage(options.schoolId || "", options.forceRelease, options.releaseStage);
  if (releaseStage === "pending") {
    await savePendingScript(scriptName, content);
    const meta = await buildScriptMeta(scriptName, content, {
      previousMeta: options.previousMeta,
      releaseStage,
      appliedBy: options.appliedBy,
      context: options.context || null,
      validate: { ok: true },
      replay: { ok: true }
    });
    await pushScriptHistory(scriptName, {
      type: "pending",
      appliedBy: options.appliedBy || "auto-repair",
      schoolId: options.schoolId || "",
      releaseStage,
      meta,
      previousMeta: options.previousMeta || null,
      context: options.context || null,
      validate: { ok: true },
      replay: { ok: true }
    });
    return { ok: true, pending: true, releaseStage };
  }
  const fullPath = buildScriptPath(scriptName);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (previousContent) {
      const previousVersion = options.previousMeta?.version || 0;
      await saveScriptBackup(scriptName, previousVersion, previousContent);
    }
    await fs.writeFile(fullPath, content, "utf-8");
    const meta = await buildScriptMeta(scriptName, content, {
      previousMeta: options.previousMeta,
      releaseStage,
      appliedBy: options.appliedBy,
      context: options.context || null,
      validate: { ok: true },
      replay: { ok: true }
    });
    await writeScriptMeta(scriptName, meta);
    await pushScriptHistory(scriptName, {
      type: options.actionType || "apply",
      appliedBy: options.appliedBy || "auto-repair",
      schoolId: options.schoolId || "",
      releaseStage,
      meta,
      previousMeta: options.previousMeta || null,
      context: options.context || null,
      validate: { ok: true },
      replay: { ok: true }
    });
    return { ok: true };
  } catch (error) {
    if (previousContent) {
      try {
        await fs.writeFile(fullPath, previousContent, "utf-8");
      } catch {
        return { ok: false, reason: "脚本写入失败且回滚失败", failureType: "rollback" };
      }
    }
    return { ok: false, reason: error?.message || "脚本写入失败", failureType: "write" };
  }
}

/**
 * 结构与语法校验
 * 1. 验证基础代码闭包与函数结构
 * 2. 拦截敏感关键字 (如 require 等)，避免安全漏洞
 * 3. 使用 new Function 测试语法的合法性
 */
function validateScriptStructure(content) {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 50) {
    return { ok: false, reason: "脚本内容过短" };
  }
  if (!/return\s+/.test(trimmed)) {
    return { ok: false, reason: "脚本缺少 return 语句" };
  }
  if (!/JSON\.stringify/.test(trimmed) && !/__dawnResult/.test(trimmed)) {
    return { ok: false, reason: "脚本缺少 JSON 输出" };
  }
  if (/require\s*\(/.test(trimmed)) {
    return { ok: false, reason: "脚本包含不允许的模块依赖" };
  }
  try {
    new Function(trimmed);
  } catch {
    return { ok: false, reason: "脚本语法不合法" };
  }
  return { ok: true };
}

/**
 * 构建带有版本链信息的脚本元数据 (Meta)
 * 包括脚本名、版本号、父版本号(用于回滚)、文件哈希、签名等
 */
async function buildScriptMeta(scriptName, content, options = {}) {
  const previousMeta = options.previousMeta || (await getScriptMeta(scriptName));
  const version = (previousMeta?.version || 0) + 1;
  const sha256 = hashText(content);
  const { signature, alg } = signScript(content);
  const ctx = options.context || null;
  const validate = options.validate || null;
  const replay = options.replay || null;
  return {
    scriptName,
    version,
    parentVersion: previousMeta?.version || 0,
    parentSha256: previousMeta?.sha256 || "",
    sha256,
    signature,
    alg,
    appliedBy: options.appliedBy || "auto-repair",
    releaseStage: options.releaseStage || "active",
    updatedAt: Date.now(),
    context: ctx,
    validate,
    replay
  };
}

/**
 * 获取脚本 meta
 * - 优先读取 Redis 缓存
 * - 若磁盘 meta 缺失，尝试 legacy 目录迁移
 * - 仍缺失则根据当前脚本内容生成 meta 并落盘
 */
async function getScriptMeta(scriptName) {
  const metaKey = buildScriptMetaKey(scriptName);
  if (redisReady) {
    const cached = await redisClient.get(metaKey);
    if (cached) return safeJson(cached);
  }
  const metaPath = buildScriptMetaPath(scriptName);
  const raw = await readTextIfExists(metaPath);
  if (raw) {
    if (redisReady) {
      await redisClient.set(metaKey, raw);
    }
    return safeJson(raw);
  }
  const legacyMeta = await readLegacyMeta(scriptName);
  if (legacyMeta) {
    await writeScriptMeta(scriptName, legacyMeta);
    return legacyMeta;
  }
  const scriptContent = await readScript(scriptName);
  if (scriptContent) {
    const meta = await buildScriptMeta(scriptName, scriptContent, {
      previousMeta: { version: 0, sha256: "" },
      appliedBy: "legacy-migrate",
      releaseStage: "active"
    });
    await writeScriptMeta(scriptName, meta);
    return meta;
  }
  return null;
}

/**
 * 读取 legacy 目录的 meta（若存在）
 */
async function readLegacyMeta(scriptName) {
  const metaFileName = buildScriptMetaFileName(scriptName);
  for (const legacyDir of legacyScriptOutputDirs) {
    const metaPath = path.join(legacyDir, metaFileName);
    const raw = await readTextIfExists(metaPath);
    if (raw) return safeJson(raw);
  }
  return null;
}

async function writeScriptMeta(scriptName, meta) {
  const metaKey = buildScriptMetaKey(scriptName);
  const metaPath = buildScriptMetaPath(scriptName);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  const raw = JSON.stringify(meta);
  if (redisReady) {
    await Promise.all([redisClient.set(metaKey, raw), fs.writeFile(metaPath, raw, "utf-8")]);
  } else {
    await fs.writeFile(metaPath, raw, "utf-8");
  }
}

async function writeBackupScript(scriptName, version, content) {
  const baseName = sanitizeScriptName(scriptName).replace(/\.js$/i, "");
  const resolvedVersion = Number(version || 0);
  const backupName = resolvedVersion > 0 ? `${baseName}.v${resolvedVersion}.js` : `${baseName}.v0.js`;
  const fullPath = path.join(scriptBackupDir, backupName);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return fullPath;
}

async function readBackupScript(scriptName, version) {
  const baseName = sanitizeScriptName(scriptName).replace(/\.js$/i, "");
  const resolvedVersion = Number(version || 0);
  if (resolvedVersion <= 0) return "";
  const fullPath = path.join(scriptBackupDir, `${baseName}.v${resolvedVersion}.js`);
  return (await readTextIfExists(fullPath)) || "";
}

function signScript(content) {
  if (scriptSignPrivateKey) {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(content);
    return { signature: signer.sign(scriptSignPrivateKey, "base64"), alg: "rsa-sha256" };
  }
  if (scriptSignKey) {
    const signature = crypto.createHmac("sha256", scriptSignKey).update(content).digest("hex");
    return { signature, alg: "hmac-sha256" };
  }
  return { signature: "", alg: "" };
}

function buildScriptFailureKey(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:failure:${safeName}`;
}

/**
 * 检测某个脚本最近的失败次数是否达到阈值，判定是否需要触发自动回滚
 */
async function shouldAutoRollback(scriptName) {
  if (!redisReady) return false;
  const key = buildScriptFailureKey(scriptName);
  const now = Date.now();
  await redisClient.zRemRangeByScore(key, 0, now - rollbackFailureWindowMs);
  const count = await redisClient.zCard(key);
  return count >= rollbackFailureThreshold;
}

/**
 * 尝试对发生频繁失败的脚本执行自动回滚
 * 依赖于元数据中记录的 parentVersion 链路和备份文件
 */
async function tryAutoRollback(scriptName) {
  if (!redisReady) return;
  const shouldRollback = await shouldAutoRollback(scriptName);
  if (!shouldRollback) return;
  const meta = await getScriptMeta(scriptName);
  if (!meta || !meta.parentVersion) return;
  if (Date.now() - Number(meta.updatedAt || 0) > rollbackFailureWindowMs) return;
  const backup = await loadScriptBackup(scriptName, meta.parentVersion);
  if (!backup) return;
  const current = await readScript(scriptName);
  await applyScriptUpdate(scriptName, backup, current, {
    previousMeta: meta,
    forceRelease: true,
    releaseStage: "rollback",
    appliedBy: "auto-rollback",
    actionType: "rollback_auto"
  });
}

/**
 * 记录脚本执行/生成的失败信息
 * 将失败记录写入 Redis 列表（用于面板展示）及有序集合（用于计算失败率和自动回滚）
 * @param {string} scriptName 脚本名
 * @param {string} reason 失败原因
 * @param {string} failureType 失败分类 (validation, replay, run 等)
 */
async function recordScriptFailure(scriptName, reason, failureType, schoolId, options = {}) {
  if (!redisReady) return;
  const now = Date.now();
  const payload = {
    scriptName: sanitizeScriptName(scriptName),
    reason,
    failureType: failureType || "unknown",
    stage: options.stage || "",
    retryable: Boolean(options.retryable),
    scriptVersion: Number(options.scriptVersion || 0),
    schoolId: schoolId || "",
    createdAt: now
  };
  await redisClient.lPush("script:failures", JSON.stringify(payload));
  await redisClient.lTrim("script:failures", 0, 200);
  await pushScriptHistory(scriptName, {
    type: "failure",
    appliedBy: options.appliedBy || "system",
    schoolId: schoolId || "",
    releaseStage: options.stage || "",
    failure: {
      failureType: payload.failureType,
      reason: payload.reason,
      retryable: payload.retryable,
      scriptVersion: payload.scriptVersion
    }
  });
  const failureKey = buildScriptFailureKey(scriptName);
  await redisClient.zAdd(failureKey, { score: now, value: `${now}:${payload.failureType}` });
  await redisClient.zRemRangeByScore(failureKey, 0, now - rollbackFailureWindowMs);
  if (options.autoRollbackEligible !== false) {
    await tryAutoRollback(scriptName);
  }
}

function buildScriptFeedbackKey(scriptName, scriptVersion) {
  const safeScriptName = sanitizeScriptName(scriptName);
  const version = Number(scriptVersion || 0);
  return `script:feedback:${safeScriptName}:v${version}`;
}

function buildScriptFeedbackErrorListKey(scriptName) {
  const safeScriptName = sanitizeScriptName(scriptName);
  return `script:feedback:errors:${safeScriptName}`;
}

function buildScriptFeedbackVersionSetKey(scriptName) {
  const safeScriptName = sanitizeScriptName(scriptName);
  return `script:feedback:versions:${safeScriptName}`;
}

function buildScriptSessionFinalKey(parseSessionId) {
  return `script:session:final:${(parseSessionId || "").toString().trim()}`;
}

function buildScriptSessionSummaryKey(scriptName) {
  return `script:session:summary:${sanitizeScriptName(scriptName)}`;
}

function buildScriptSessionGlobalKey() {
  return "script:session:summary:global";
}

function buildScriptSessionScriptSetKey() {
  return "script:session:scripts";
}

function buildScriptPullDailyKey(dateKey) {
  return `script:pull:daily:${dateKey}`;
}

function buildScriptPullScriptDailyKey(scriptName, dateKey) {
  return `script:pull:script:${sanitizeScriptName(scriptName)}:${dateKey}`;
}

function buildScriptPullScriptSetKey(dateKey) {
  return `script:pull:scripts:${dateKey}`;
}

function buildScriptPullTaskDailySetKey(dateKey) {
  return `script:pull:tasks:${dateKey}`;
}

function buildScriptPullTaskScriptSetKey(scriptName, dateKey) {
  return `script:pull:task:script:${sanitizeScriptName(scriptName)}:${dateKey}`;
}

function formatDateKey(timestamp) {
  const d = new Date(Number(timestamp || Date.now()));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * 记录 App 端脚本拉取统计
 *
 * 说明：
 * 1. 每次 App 请求云端脚本都会上报一次（不区分成功/降级路径）
 * 2. 统计维度包含：日期总量、来源类型、脚本名维度次数
 * 3. Redis 不可用时退化为仅打印日志，不影响主流程
 */
async function recordScriptPull(payload) {
  const scriptName = sanitizeScriptName(payload?.scriptName || "");
  const category = (payload?.category || "").toString();
  const source = (payload?.source || "").toString() || "unknown";
  const pullTaskId = sanitizeScriptName(payload?.pullTaskId || "");
  const fromCloud = payload?.fromCloud === true;
  const clientIp = (payload?.clientIp || "").toString();
  const userAgent = (payload?.userAgent || "").toString();
  const now = Date.now();
  const dateKey = formatDateKey(now);
  if (!redisReady) {
    console.log("[script_pull]", JSON.stringify({ scriptName, category, source, fromCloud, clientIp, userAgent }));
    return;
  }
  const dailyKey = buildScriptPullDailyKey(dateKey);
  const dailyTaskSetKey = buildScriptPullTaskDailySetKey(dateKey);
  await redisClient.hIncrBy(dailyKey, "total", 1);
  await redisClient.hIncrBy(dailyKey, fromCloud ? "fromCloud" : "fromLocal", 1);
  await redisClient.hIncrBy(dailyKey, `source:${source || "unknown"}`, 1);
  await redisClient.expire(dailyKey, Math.ceil(backupTtlMs / 1000));
  if (pullTaskId) {
    const isNewTask = await redisClient.sAdd(dailyTaskSetKey, pullTaskId);
    await redisClient.expire(dailyTaskSetKey, Math.ceil(backupTtlMs / 1000));
    if (isNewTask > 0) {
      await redisClient.hIncrBy(dailyKey, "uniqueTotal", 1);
      await redisClient.hIncrBy(dailyKey, fromCloud ? "uniqueFromCloud" : "uniqueFromLocal", 1);
    }
  }
  if (scriptName) {
    const scriptDailyKey = buildScriptPullScriptDailyKey(scriptName, dateKey);
    const scriptSetKey = buildScriptPullScriptSetKey(dateKey);
    const scriptTaskSetKey = buildScriptPullTaskScriptSetKey(scriptName, dateKey);
    await redisClient.sAdd(scriptSetKey, scriptName);
    await redisClient.expire(scriptSetKey, Math.ceil(backupTtlMs / 1000));
    await redisClient.hIncrBy(scriptDailyKey, "total", 1);
    await redisClient.hIncrBy(scriptDailyKey, fromCloud ? "fromCloud" : "fromLocal", 1);
    await redisClient.hIncrBy(scriptDailyKey, `source:${source || "unknown"}`, 1);
    await redisClient.hSet(scriptDailyKey, {
      scriptName,
      category,
      updatedAt: now
    });
    await redisClient.expire(scriptDailyKey, Math.ceil(backupTtlMs / 1000));
    if (pullTaskId) {
      const isNewScriptTask = await redisClient.sAdd(scriptTaskSetKey, pullTaskId);
      await redisClient.expire(scriptTaskSetKey, Math.ceil(backupTtlMs / 1000));
      if (isNewScriptTask > 0) {
        await redisClient.hIncrBy(scriptDailyKey, "uniqueTotal", 1);
        await redisClient.hIncrBy(scriptDailyKey, fromCloud ? "uniqueFromCloud" : "uniqueFromLocal", 1);
      }
    }
  }
}

async function getScriptPullSummary() {
  if (!redisReady) return {};
  const dateKey = formatDateKey(Date.now());
  const daily = await redisClient.hGetAll(buildScriptPullDailyKey(dateKey));
  if (!daily || Object.keys(daily).length === 0) return {};
  const scriptSetKey = buildScriptPullScriptSetKey(dateKey);
  const scriptNames = await redisClient.sMembers(scriptSetKey);
  const scriptStats = [];
  for (const scriptNameRaw of scriptNames) {
    const scriptName = sanitizeScriptName(scriptNameRaw);
    if (!scriptName) continue;
    const scriptDailyKey = buildScriptPullScriptDailyKey(scriptName, dateKey);
    const item = await redisClient.hGetAll(scriptDailyKey);
    if (!item || Object.keys(item).length === 0) continue;
    const sourceStats = Object.keys(item)
      .filter((key) => key.startsWith("source:"))
      .reduce((acc, key) => {
        acc[key.replace("source:", "")] = Number(item[key] || 0);
        return acc;
      }, {});
    scriptStats.push({
      scriptName,
      category: item.category || "",
      total: Number(item.total || 0),
      fromCloud: Number(item.fromCloud || 0),
      fromLocal: Number(item.fromLocal || 0),
      uniqueTotal: Number(item.uniqueTotal || 0),
      uniqueFromCloud: Number(item.uniqueFromCloud || 0),
      uniqueFromLocal: Number(item.uniqueFromLocal || 0),
      sourceStats,
      updatedAt: Number(item.updatedAt || 0)
    });
  }
  scriptStats.sort((a, b) => b.total - a.total || b.updatedAt - a.updatedAt);
  return {
    dateKey,
    total: Number(daily.total || 0),
    fromCloud: Number(daily.fromCloud || 0),
    fromLocal: Number(daily.fromLocal || 0),
    uniqueTotal: Number(daily.uniqueTotal || 0),
    uniqueFromCloud: Number(daily.uniqueFromCloud || 0),
    uniqueFromLocal: Number(daily.uniqueFromLocal || 0),
    sourceStats: Object.keys(daily)
      .filter((key) => key.startsWith("source:"))
      .reduce((acc, key) => {
        acc[key.replace("source:", "")] = Number(daily[key] || 0);
        return acc;
      }, {}),
    scriptStats
  };
}

async function recordScriptParseFeedback(payload) {
  if (!redisReady) return;
  const scriptName = sanitizeScriptName(payload?.scriptName || "");
  if (!scriptName) return;
  const scriptVersion = Number(payload?.scriptVersion || 0);
  const success = payload?.success === true;
  const category = (payload?.category || "").toString();
  const errorMessage = (payload?.errorMessage || "").toString();
  const sourceUrl = (payload?.sourceUrl || "").toString();
  const parseSessionId = (payload?.parseSessionId || "").toString().trim();
  const isSessionFinal = payload?.isSessionFinal === true;
  const finalResult = normalizeFinalResult(payload?.finalResult);
  const failureType = normalizeSubmissionFailureType(payload?.failureType) || "unknown";
  const schoolSystemType = normalizeSchoolSystemType(payload?.schoolSystemType) || "unknown";
  const attemptedParsers = Array.isArray(payload?.attemptedParsers)
    ? payload.attemptedParsers.map((item) => sanitizeScriptName(item)).filter(Boolean).slice(0, 12)
    : [];
  const now = Date.now();
  const key = buildScriptFeedbackKey(scriptName, scriptVersion);
  const versionSetKey = buildScriptFeedbackVersionSetKey(scriptName);
  await redisClient.sAdd("script:feedback:scripts", scriptName);
  await redisClient.sAdd(versionSetKey, scriptVersion.toString());
  await redisClient.expire(versionSetKey, Math.ceil(backupTtlMs / 1000));
  await redisClient.hSet(key, {
    scriptName,
    scriptVersion,
    category,
    updatedAt: now,
    lastSourceUrl: sourceUrl
  });
  await redisClient.hIncrBy(key, success ? "successCount" : "failureCount", 1);
  if (!success && errorMessage) {
    const errorPayload = JSON.stringify({
      scriptName,
      scriptVersion,
      category,
      errorMessage,
      sourceUrl,
      createdAt: now
    });
    const errorKey = buildScriptFeedbackErrorListKey(scriptName);
    await redisClient.lPush(errorKey, errorPayload);
    await redisClient.lTrim(errorKey, 0, Math.max(0, scriptFeedbackErrorLimit - 1));
  }
  if (!isSessionFinal || !parseSessionId || !finalResult) {
    return;
  }
  const finalKey = buildScriptSessionFinalKey(parseSessionId);
  const accepted = await redisClient.set(finalKey, scriptName, { NX: true, PX: backupTtlMs });
  if (!accepted) {
    return;
  }
  const summaryKey = buildScriptSessionSummaryKey(scriptName);
  const globalKey = buildScriptSessionGlobalKey();
  await redisClient.sAdd(buildScriptSessionScriptSetKey(), scriptName);
  await redisClient.hSet(summaryKey, {
    scriptName,
    updatedAt: now,
    lastSourceUrl: sourceUrl,
    lastFinalResult: finalResult,
    lastFailureType: failureType,
    lastSchoolSystemType: schoolSystemType,
    lastAttemptedParsers: JSON.stringify(attemptedParsers)
  });
  await redisClient.hSet(globalKey, { updatedAt: now });
  const resultField = finalResult === "success" ? "successCount" : "failureCount";
  await redisClient.hIncrBy(summaryKey, resultField, 1);
  await redisClient.hIncrBy(globalKey, resultField, 1);
  if (schoolSystemType) {
    await redisClient.hIncrBy(summaryKey, `system:${schoolSystemType}`, 1);
    await redisClient.hIncrBy(globalKey, `system:${schoolSystemType}`, 1);
  }
  if (finalResult === "failed") {
    await redisClient.hIncrBy(summaryKey, `failure:${failureType}`, 1);
    await redisClient.hIncrBy(globalKey, `failure:${failureType}`, 1);
  }
}

async function getScriptFeedbackSummary() {
  if (!redisReady) return {};
  const scripts = await redisClient.sMembers("script:feedback:scripts");
  const summary = {};
  for (const scriptNameRaw of scripts) {
    const scriptName = sanitizeScriptName(scriptNameRaw);
    const versions = [];
    const versionValues = await redisClient.sMembers(buildScriptFeedbackVersionSetKey(scriptName));
    for (const versionRaw of versionValues) {
      const version = Number(versionRaw || 0);
      if (!Number.isFinite(version) || version < 0) continue;
      const key = buildScriptFeedbackKey(scriptName, version);
      const item = await redisClient.hGetAll(key);
      if (!item || Object.keys(item).length === 0) continue;
      const successCount = Number(item.successCount || 0);
      const failureCount = Number(item.failureCount || 0);
      versions.push({
        scriptVersion: Number(item.scriptVersion || 0),
        category: item.category || "",
        successCount,
        failureCount,
        totalCount: successCount + failureCount,
        successRate:
          successCount + failureCount > 0
            ? Number((successCount / (successCount + failureCount)).toFixed(4))
            : 0,
        lastSourceUrl: item.lastSourceUrl || "",
        updatedAt: Number(item.updatedAt || 0)
      });
    }
    versions.sort((a, b) => b.scriptVersion - a.scriptVersion);
    if (versions.length) {
      summary[scriptName] = versions;
    }
  }
  return summary;
}

async function getScriptSessionSummary() {
  const empty = {
    totals: {
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
      successRate: 0
    },
    bySystem: {},
    byFailureType: {},
    byScript: {}
  };
  if (!redisReady) return empty;
  const global = await redisClient.hGetAll(buildScriptSessionGlobalKey());
  const successCount = Number(global?.successCount || 0);
  const failureCount = Number(global?.failureCount || 0);
  const totalCount = successCount + failureCount;
  const bySystem = {};
  const byFailureType = {};
  for (const [key, value] of Object.entries(global || {})) {
    if (key.startsWith("system:")) {
      bySystem[key.replace("system:", "")] = Number(value || 0);
    } else if (key.startsWith("failure:")) {
      byFailureType[key.replace("failure:", "")] = Number(value || 0);
    }
  }
  const byScript = {};
  const scripts = await redisClient.sMembers(buildScriptSessionScriptSetKey());
  for (const scriptNameRaw of scripts) {
    const scriptName = sanitizeScriptName(scriptNameRaw);
    if (!scriptName) continue;
    const item = await redisClient.hGetAll(buildScriptSessionSummaryKey(scriptName));
    if (!item || Object.keys(item).length === 0) continue;
    const scriptSuccess = Number(item.successCount || 0);
    const scriptFailure = Number(item.failureCount || 0);
    const scriptTotal = scriptSuccess + scriptFailure;
    const scriptBySystem = {};
    const scriptByFailureType = {};
    for (const [key, value] of Object.entries(item)) {
      if (key.startsWith("system:")) {
        scriptBySystem[key.replace("system:", "")] = Number(value || 0);
      } else if (key.startsWith("failure:")) {
        scriptByFailureType[key.replace("failure:", "")] = Number(value || 0);
      }
    }
    const unknownCount = Number(scriptBySystem.unknown || 0);
    byScript[scriptName] = {
      scriptName,
      successCount: scriptSuccess,
      failureCount: scriptFailure,
      totalCount: scriptTotal,
      successRate: scriptTotal > 0 ? Number((scriptSuccess / scriptTotal).toFixed(4)) : 0,
      bySystem: scriptBySystem,
      byFailureType: scriptByFailureType,
      lastSourceUrl: item.lastSourceUrl || "",
      lastFinalResult: item.lastFinalResult || "",
      lastFailureType: item.lastFailureType || "",
      updatedAt: Number(item.updatedAt || 0),
      unknownRate: scriptTotal > 0 ? Number((unknownCount / scriptTotal).toFixed(4)) : 0
    };
  }
  return {
    totals: {
      successCount,
      failureCount,
      totalCount,
      successRate: totalCount > 0 ? Number((successCount / totalCount).toFixed(4)) : 0
    },
    bySystem,
    byFailureType,
    byScript
  };
}

async function recordMetric(type, latencyMs, cost) {
  const key = buildMetricKey(type);
  await redisClient.hIncrBy(key, "count", 1);
  await redisClient.hIncrByFloat(key, "latencyMsTotal", latencyMs);
  if (cost > 0) {
    await redisClient.hIncrByFloat(key, "costTotal", cost);
  }
  await redisClient.hSet(key, { lastUpdatedAt: Date.now() });
}

async function recordSchoolMetric(schoolId, type, latencyMs, cost) {
  const key = buildSchoolMetricKey(schoolId);
  await redisClient.sAdd("school:metrics:ids", schoolId);
  await redisClient.hIncrBy(key, type, 1);
  await redisClient.hIncrByFloat(key, "latencyMsTotal", latencyMs);
  if (cost > 0) {
    await redisClient.hIncrByFloat(key, "costTotal", cost);
  }
  await redisClient.hSet(key, { lastUpdatedAt: Date.now() });
  scheduleMetricsFlush();
}

function scheduleMetricsFlush() {
  if (metricsFlushTimer) return;
  metricsFlushTimer = setTimeout(async () => {
    metricsFlushTimer = null;
    await flushSchoolMetricsToFile();
  }, metricsFlushMs);
}

function isEmptyResult(resultText) {
  const data = safeJson(resultText);
  return Array.isArray(data) && data.length === 0;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * 全局速率限制器
 * 对同 IP 和同学校 ID 分别进行请求速率限制，避免恶意攻击或重试风暴打挂服务端
 */
async function checkRateLimit(ip, schoolId) {
  const ipKey = `rate:ip:${ip}`;
  const ipCount = await redisClient.incr(ipKey);
  if (ipCount === 1) {
    await redisClient.expire(ipKey, 60);
  }
  if (ipCount > rateLimitPerMin) return false;
  if (schoolId) {
    const schoolKey = `rate:school:${schoolId}`;
    const schoolCount = await redisClient.incr(schoolKey);
    if (schoolCount === 1) {
      await redisClient.expire(schoolKey, 60);
    }
    if (schoolCount > rateLimitSchoolPerMin) return false;
  }
  return true;
}

/**
 * 使用 Redis 保存任务状态，设置生命周期 taskTtlMs
 */
async function saveTask(taskId, task) {
  const key = buildTaskKey(taskId);
  await redisClient.set(key, JSON.stringify(task), { PX: taskTtlMs });
}

async function getTask(taskId) {
  const key = buildTaskKey(taskId);
  const raw = await redisClient.get(key);
  return raw ? safeJson(raw) : null;
}

async function getSchoolQueue(schoolId) {
  const key = buildQueueKey(schoolId);
  const items = await redisClient.lRange(key, 0, -1);
  return items.map((item) => safeJson(item)).filter(Boolean);
}

async function clearSchoolQueue(schoolId) {
  const key = buildQueueKey(schoolId);
  await redisClient.del(key);
}

async function getSchoolState(schoolId) {
  const key = buildSchoolStateKey(schoolId);
  const raw = await redisClient.get(key);
  return raw ? safeJson(raw) : null;
}

async function setSchoolState(schoolId, state) {
  const key = buildSchoolStateKey(schoolId);
  await redisClient.set(key, JSON.stringify(state), { PX: reprocessWindowMs });
}

/**
 * 合并更新学校状态，避免覆盖已有字段
 */
async function updateSchoolState(schoolId, patch) {
  const existing = (await getSchoolState(schoolId)) || {};
  const next = { ...existing, ...patch };
  await setSchoolState(schoolId, next);
  return next;
}

/**
 * 更新学校队列状态机阶段
 */
/**
 * 更新学校当前的处理阶段（状态机）
 * 用于运维面板展示及故障排查
 * 阶段包含：IDLE, WAITING_WINDOW, MERGING, REPAIRING, APPLYING, FAILED_RETRYING 等
 */
async function setSchoolPhase(schoolId, phase) {
  if (!schoolId) return;
  await updateSchoolState(schoolId, {
    phase,
    phaseUpdatedAt: Date.now()
  });
}

/**
 * 从队列中剔除过期任务
 * 如果发现某个学校的队列长时间没有新提交且没达到修复阈值，则自动修剪
 */
async function pruneQueueIfNeeded(schoolId, queue) {
  if (!Array.isArray(queue) || queue.length === 0) return [];
  const now = Date.now();
  const filtered = queue.filter((item) => now - item.createdAt <= queueItemTtlMs);
  if (filtered.length === queue.length) return filtered;
  const key = buildQueueKey(schoolId);
  await redisClient.del(key);
  if (filtered.length > 0) {
    await redisClient.rPush(key, ...filtered.map((item) => JSON.stringify(item)));
    await redisClient.expire(key, Math.ceil(queueItemTtlMs / 1000));
  }
  return filtered;
}

async function getMetricsSnapshot() {
  const types = [
    "parse_success",
    "parse_failed",
    "parse_empty",
    "summary_success",
    "summary_failed",
    "script_success",
    "script_failed"
  ];
  const result = {};
  if (!redisReady) {
    for (const type of types) {
      result[type] = {
        count: 0,
        latencyMsAvg: 0,
        costTotal: 0,
        lastUpdatedAt: 0
      };
    }
    return result;
  }
  for (const type of types) {
    const key = buildMetricKey(type);
    const data = await redisClient.hGetAll(key);
    const count = Number(data.count || 0);
    const latencyMsTotal = Number(data.latencyMsTotal || 0);
    const costTotal = Number(data.costTotal || 0);
    result[type] = {
      count,
      latencyMsAvg: count > 0 ? latencyMsTotal / count : 0,
      costTotal,
      lastUpdatedAt: Number(data.lastUpdatedAt || 0)
    };
  }
  return result;
}

async function getSchoolMetricsSnapshot() {
  if (!redisReady) return {};
  const ids = await redisClient.sMembers("school:metrics:ids");
  const result = {};
  for (const schoolId of ids) {
    const data = await redisClient.hGetAll(buildSchoolMetricKey(schoolId));
    result[schoolId] = {
      parse_success: Number(data.parse_success || 0),
      parse_failed: Number(data.parse_failed || 0),
      parse_empty: Number(data.parse_empty || 0),
      summary_success: Number(data.summary_success || 0),
      summary_failed: Number(data.summary_failed || 0),
      script_success: Number(data.script_success || 0),
      script_failed: Number(data.script_failed || 0),
      latencyMsTotal: Number(data.latencyMsTotal || 0),
      costTotal: Number(data.costTotal || 0),
      lastUpdatedAt: Number(data.lastUpdatedAt || 0)
    };
  }
  return result;
}

async function flushSchoolMetricsToFile() {
  const snapshot = await getSchoolMetricsSnapshot();
  const lines = [];
  for (const [schoolId, data] of Object.entries(snapshot)) {
    const parseTotal = data.parse_success + data.parse_failed + data.parse_empty;
    const parseSuccessRate = parseTotal > 0 ? data.parse_success / parseTotal : 0;
    lines.push(
      [
        schoolId,
        parseSuccessRate.toFixed(6),
        data.parse_success,
        data.parse_failed,
        data.parse_empty,
        data.summary_success,
        data.summary_failed,
        data.script_success,
        data.script_failed,
        data.costTotal.toFixed(6),
        data.lastUpdatedAt
      ].join("\t")
    );
  }
  await fs.mkdir(path.dirname(schoolMetricsFile), { recursive: true });
  await fs.writeFile(schoolMetricsFile, lines.join("\n"), "utf-8");
}

async function buildPrometheusMetrics() {
  const metrics = await getMetricsSnapshot();
  const schoolMetrics = await getSchoolMetricsSnapshot();
  const lines = [];
  for (const [type, data] of Object.entries(metrics)) {
    lines.push(`dawncourse_${type}_total ${data.count}`);
    lines.push(`dawncourse_${type}_latency_avg_ms ${data.latencyMsAvg}`);
    lines.push(`dawncourse_${type}_cost_total ${data.costTotal}`);
    lines.push(`dawncourse_${type}_last_updated ${data.lastUpdatedAt}`);
  }
  for (const [schoolId, data] of Object.entries(schoolMetrics)) {
    const safeSchoolId = String(schoolId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const label = `schoolId="${safeSchoolId}"`;
    lines.push(`dawncourse_school_parse_success_total{${label}} ${data.parse_success}`);
    lines.push(`dawncourse_school_parse_failed_total{${label}} ${data.parse_failed}`);
    lines.push(`dawncourse_school_parse_empty_total{${label}} ${data.parse_empty}`);
    lines.push(`dawncourse_school_summary_success_total{${label}} ${data.summary_success}`);
    lines.push(`dawncourse_school_summary_failed_total{${label}} ${data.summary_failed}`);
    lines.push(`dawncourse_school_script_success_total{${label}} ${data.script_success}`);
    lines.push(`dawncourse_school_script_failed_total{${label}} ${data.script_failed}`);
    lines.push(`dawncourse_school_cost_total{${label}} ${data.costTotal}`);
    lines.push(`dawncourse_school_last_updated{${label}} ${data.lastUpdatedAt}`);
  }
  return lines.join("\n");
}

/**
 * 获取所有已出现的学校 ID（队列与指标两处合并）
 */
async function getKnownSchoolIds() {
  const ids = await redisClient.sMembers("school:ids");
  const metricIds = await redisClient.sMembers("school:metrics:ids");
  return Array.from(new Set([...ids, ...metricIds]));
}

/**
 * 生成并缓存聚合统计数据，供运维管理面板展示
 * 包括整体成功率、按教务类型的任务分布、失败分类以及最近的异常记录
 */
async function buildAdminDashboardData() {
  if (adminLocalMode) {
    return {
      serverStartedAt,
      metrics: {},
      schoolMetrics: {},
      schoolQueues: {},
      failures: [],
      metricsFile: "",
      schoolCount: 0,
      totalQueueLength: 0,
      parsePendingQueueLength: 0,
      parseProviderReady: false,
      failureCount: 0,
      latestMetricsAt: 0,
      schoolInfoById: {},
      failureTypeStats: {},
      scriptParseFeedback: {},
      scriptSessionFeedback: {},
      scriptPullStats: {},
      modelUsage: {
        summary: {
          provider: summaryProvider,
          model: summaryModel,
          inputTokens: 0,
          outputTokens: 0,
          tokenTotal: 0,
          costTotal: 0,
          currency: "",
          updatedAt: 0,
          window: null,
          usageUrl: "",
          costUrl: "",
          error: "local_mode"
        },
        script: {
          provider: scriptProvider,
          model: scriptModel,
          inputTokens: 0,
          outputTokens: 0,
          tokenTotal: 0,
          costTotal: 0,
          currency: "",
          updatedAt: 0,
          window: null,
          usageUrl: "",
          costUrl: "",
          error: "local_mode"
        }
      }
    };
  }
  if (!redisReady) {
    const [metrics, usageSummary, usageScript] = await Promise.all([
      getMetricsSnapshot(),
      getUsageSnapshot("summary"),
      getUsageSnapshot("script")
    ]);
    const metricUpdatedAtList = Object.values(metrics || {}).map((item) => item?.lastUpdatedAt || 0);
    const latestMetricsAt = Math.max(0, ...metricUpdatedAtList);
    return {
      serverStartedAt,
      metrics: metrics || {},
      schoolMetrics: {},
      schoolQueues: {},
      failures: [],
      metricsFile: schoolMetricsFile,
      schoolCount: 0,
      totalQueueLength: 0,
      parsePendingQueueLength: 0,
      parseProviderReady: false,
      failureCount: 0,
      latestMetricsAt,
      schoolInfoById: {},
      failureTypeStats: {},
      scriptParseFeedback: {},
      scriptSessionFeedback: {},
      scriptPullStats: {},
      modelUsage: {
        summary: usageSummary || {
          provider: summaryProvider,
          model: summaryModel,
          inputTokens: 0,
          outputTokens: 0,
          tokenTotal: 0,
          costTotal: 0,
          currency: "",
          updatedAt: 0,
          window: null,
          usageUrl: "",
          costUrl: "",
          error: "redis_unavailable"
        },
        script: usageScript || {
          provider: scriptProvider,
          model: scriptModel,
          inputTokens: 0,
          outputTokens: 0,
          tokenTotal: 0,
          costTotal: 0,
          currency: "",
          updatedAt: 0,
          window: null,
          usageUrl: "",
          costUrl: "",
          error: "redis_unavailable"
        }
      }
    };
  }
  const [
    metrics,
    schoolMetrics,
    failures,
    schoolIds,
    schoolInfoById,
    usageSummary,
    usageScript,
    scriptParseFeedback,
    scriptSessionFeedback,
    scriptPullStats,
    repairIssues
  ] =
    await Promise.all([
      getMetricsSnapshot(),
      getSchoolMetricsSnapshot(),
      getScriptFailures(200),
      getKnownSchoolIds(),
      getSchoolInfoMap(),
      getUsageSnapshot("summary"),
      getUsageSnapshot("script"),
      getScriptFeedbackSummary(),
      getScriptSessionSummary(),
      getScriptPullSummary(),
      listRepairIssues(100)
    ]);
  const schoolQueues = {};
  let totalQueueLength = 0;
  const parsePendingQueueLength = await redisClient.lLen(buildPendingParseKey());
  const queueLengths = await Promise.all(
    schoolIds.map(async (schoolId) => {
      const queueLength = await redisClient.lLen(buildQueueKey(schoolId));
      return { schoolId, queueLength };
    })
  );
  for (const item of queueLengths) {
    const schoolId = item.schoolId;
    const queueLength = item.queueLength;
    schoolQueues[schoolId] = queueLength;
    totalQueueLength += queueLength;
  }
  const failureTypeStats = {};
  for (const item of failures) {
    const type = item?.failureType || "unknown";
    failureTypeStats[type] = (failureTypeStats[type] || 0) + 1;
  }
  const metricUpdatedAtList = Object.values(metrics).map((item) => item.lastUpdatedAt || 0);
  const schoolUpdatedAtList = Object.values(schoolMetrics).map((item) => item.lastUpdatedAt || 0);
  const latestMetricsAt = Math.max(0, ...metricUpdatedAtList, ...schoolUpdatedAtList);
  return {
    serverStartedAt,
    metrics,
    schoolMetrics,
    schoolQueues,
    failures,
    metricsFile: schoolMetricsFile,
    schoolCount: schoolIds.length,
    totalQueueLength,
    parsePendingQueueLength,
    parseProviderReady: isParseProviderReady(),
    failureCount: failures.length,
    latestMetricsAt,
    schoolInfoById,
    failureTypeStats,
    scriptParseFeedback,
    scriptSessionFeedback,
    scriptPullStats,
    repairIssues,
    modelUsage: {
      summary: usageSummary,
      script: usageScript
    }
  };
}

/**
 * 使用盐值对密码做不可逆哈希
 */
function hashPassword(password, salt) {
  return hashText(`${salt}:${password}`);
}

async function initAdminUserStore() {
  const now = Date.now();
  if (adminLocalMode) {
    if (adminLocalUsers.size === 0) {
      const salt = randomString(8);
      adminLocalUsers.set("admin", {
        username: "admin",
        passwordHash: hashPassword("admin", salt),
        salt,
        createdAt: now,
        updatedAt: now
      });
      return { username: "admin", password: "admin" };
    }
    const admin = adminLocalUsers.get("admin");
    if (admin) {
      return { username: "admin", password: "admin" };
    }
    const fallback = Array.from(adminLocalUsers.values())[0] || null;
    return fallback ? { username: fallback.username, password: "" } : null;
  }
  const users = await getAdminUsers();
  if (users.length > 0) {
    const adminUser = users.find((item) => item.username === "admin");
    if (adminUser) {
      return { username: "admin", password: "admin" };
    }
    return { username: users[0].username, password: "" };
  }
  const legacyRaw = await redisClient.get(buildAdminCredentialKey());
  const legacy = legacyRaw ? safeJson(legacyRaw) : null;
  if (legacy?.username && legacy?.passwordHash) {
    const migrated = {
      username: legacy.username.toString(),
      passwordHash: legacy.passwordHash.toString(),
      salt: (legacy.salt || "").toString(),
      createdAt: Number(legacy.createdAt || now),
      updatedAt: now
    };
    await saveAdminUsers([migrated]);
    return { username: migrated.username, password: "" };
  }
  const salt = randomString(8);
  const adminUser = {
    username: "admin",
    passwordHash: hashPassword("admin", salt),
    salt,
    createdAt: now,
    updatedAt: now
  };
  await saveAdminUsers([adminUser]);
  return { username: "admin", password: "admin" };
}

async function getAdminUsers() {
  if (adminLocalMode) {
    return Array.from(adminLocalUsers.values()).map((item) => ({ ...item }));
  }
  const raw = await redisClient.get(buildAdminUsersKey());
  const list = raw ? safeJson(raw) : [];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      username: (item?.username || "").toString(),
      passwordHash: (item?.passwordHash || "").toString(),
      salt: (item?.salt || "").toString(),
      createdAt: Number(item?.createdAt || 0),
      updatedAt: Number(item?.updatedAt || 0),
      lastLoginAt: Number(item?.lastLoginAt || 0)
    }))
    .filter((item) => item.username && item.passwordHash);
}

async function saveAdminUsers(users) {
  const normalized = Array.isArray(users)
    ? users
        .map((item) => ({
          username: (item?.username || "").toString().trim(),
          passwordHash: (item?.passwordHash || "").toString(),
          salt: (item?.salt || "").toString(),
          createdAt: Number(item?.createdAt || 0),
          updatedAt: Number(item?.updatedAt || 0),
          lastLoginAt: Number(item?.lastLoginAt || 0)
        }))
        .filter((item) => item.username && item.passwordHash)
    : [];
  if (adminLocalMode) {
    adminLocalUsers.clear();
    normalized.forEach((item) => {
      adminLocalUsers.set(item.username, { ...item });
    });
    return;
  }
  await redisClient.set(buildAdminUsersKey(), JSON.stringify(normalized));
}

async function listAdminUsers() {
  const users = await getAdminUsers();
  return users
    .map((item) => ({
      username: item.username,
      createdAt: item.createdAt || 0,
      updatedAt: item.updatedAt || 0,
      lastLoginAt: item.lastLoginAt || 0
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function normalizeAdminUsername(value) {
  return (value || "").toString().trim();
}

function validateAdminPassword(value) {
  const password = (value || "").toString();
  return password.length >= 4;
}

async function createAdminUser(usernameInput, passwordInput) {
  const username = normalizeAdminUsername(usernameInput);
  if (!username) return { ok: false, code: 400, msg: "账号不能为空" };
  if (!validateAdminPassword(passwordInput)) {
    return { ok: false, code: 400, msg: "密码长度至少 4 位" };
  }
  const users = await getAdminUsers();
  if (users.some((item) => item.username === username)) {
    return { ok: false, code: 409, msg: "账号已存在" };
  }
  const now = Date.now();
  const salt = randomString(8);
  users.push({
    username,
    passwordHash: hashPassword(passwordInput, salt),
    salt,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: 0
  });
  await saveAdminUsers(users);
  return { ok: true };
}

async function renameAdminUser(oldUsernameInput, newUsernameInput) {
  const oldUsername = normalizeAdminUsername(oldUsernameInput);
  const newUsername = normalizeAdminUsername(newUsernameInput);
  if (!oldUsername || !newUsername) return { ok: false, code: 400, msg: "账号不能为空" };
  const users = await getAdminUsers();
  const target = users.find((item) => item.username === oldUsername);
  if (!target) return { ok: false, code: 404, msg: "原账号不存在" };
  if (users.some((item) => item.username === newUsername && item.username !== oldUsername)) {
    return { ok: false, code: 409, msg: "新账号已存在" };
  }
  target.username = newUsername;
  target.updatedAt = Date.now();
  await saveAdminUsers(users);
  await remapAdminSessions(oldUsername, newUsername);
  return { ok: true };
}

async function updateAdminUserPassword(usernameInput, passwordInput) {
  const username = normalizeAdminUsername(usernameInput);
  if (!username) return { ok: false, code: 400, msg: "账号不能为空" };
  if (!validateAdminPassword(passwordInput)) {
    return { ok: false, code: 400, msg: "密码长度至少 4 位" };
  }
  const users = await getAdminUsers();
  const target = users.find((item) => item.username === username);
  if (!target) return { ok: false, code: 404, msg: "账号不存在" };
  target.salt = randomString(8);
  target.passwordHash = hashPassword(passwordInput, target.salt);
  target.updatedAt = Date.now();
  await saveAdminUsers(users);
  return { ok: true };
}

async function deleteAdminUser(usernameInput) {
  const username = normalizeAdminUsername(usernameInput);
  if (!username) return { ok: false, code: 400, msg: "账号不能为空" };
  const users = await getAdminUsers();
  if (users.length <= 1) {
    return { ok: false, code: 400, msg: "至少保留一个账号" };
  }
  const nextUsers = users.filter((item) => item.username !== username);
  if (nextUsers.length === users.length) {
    return { ok: false, code: 404, msg: "账号不存在" };
  }
  await saveAdminUsers(nextUsers);
  await revokeAdminSessionsByUsername(username);
  return { ok: true };
}

async function touchAdminUserLogin(usernameInput) {
  const username = normalizeAdminUsername(usernameInput);
  if (!username) return;
  const users = await getAdminUsers();
  const target = users.find((item) => item.username === username);
  if (!target) return;
  target.lastLoginAt = Date.now();
  await saveAdminUsers(users);
}

async function remapAdminSessions(oldUsername, newUsername) {
  if (!oldUsername || !newUsername || oldUsername === newUsername) return;
  if (adminLocalMode) {
    for (const [token, session] of adminLocalSessions.entries()) {
      if (session?.username === oldUsername) {
        adminLocalSessions.set(token, { ...session, username: newUsername });
      }
    }
    return;
  }
  const keys = await redisClient.keys(buildAdminSessionKey("*"));
  for (const key of keys) {
    const username = await redisClient.get(key);
    if (username === oldUsername) {
      const ttl = await redisClient.pTTL(key);
      if (ttl > 0) {
        await redisClient.set(key, newUsername, { PX: ttl });
      } else {
        await redisClient.set(key, newUsername);
      }
    }
  }
}

async function revokeAdminSessionsByUsername(usernameInput) {
  const username = normalizeAdminUsername(usernameInput);
  if (!username) return;
  if (adminLocalMode) {
    for (const [token, session] of adminLocalSessions.entries()) {
      if (session?.username === username) {
        adminLocalSessions.delete(token);
      }
    }
    return;
  }
  const keys = await redisClient.keys(buildAdminSessionKey("*"));
  for (const key of keys) {
    const value = await redisClient.get(key);
    if (value === username) {
      await redisClient.del(key);
    }
  }
}

async function verifyAdminCredentials(username, password) {
  const users = await getAdminUsers();
  const target = users.find((item) => item.username === username);
  if (!target) return false;
  const hash = hashPassword(password, target.salt || "");
  if (hash !== target.passwordHash) return false;
  return true;
}

/**
 * 创建管理后台会话并返回 token
 */
async function createAdminSession(username) {
  const token = crypto.randomUUID();
  if (adminLocalMode) {
    adminLocalSessions.set(token, { username, expiresAt: Date.now() + adminSessionTtlMs });
    return token;
  }
  await redisClient.set(buildAdminSessionKey(token), username, { PX: adminSessionTtlMs });
  return token;
}

/**
 * 删除管理后台会话
 */
async function deleteAdminSession(token) {
  if (adminLocalMode) {
    adminLocalSessions.delete(token);
    return;
  }
  await redisClient.del(buildAdminSessionKey(token));
}

/**
 * 从请求中校验管理后台登录态
 */
async function requireAdminAuth(req) {
  const token = getBearerToken(req);
  if (!token) return { ok: false };
  if (adminLocalMode) {
    const session = adminLocalSessions.get(token);
    if (!session) return { ok: false };
    if (session.expiresAt <= Date.now()) {
      adminLocalSessions.delete(token);
      return { ok: false };
    }
    return { ok: true, username: session.username, token };
  }
  const username = await redisClient.get(buildAdminSessionKey(token));
  if (!username) return { ok: false };
  return { ok: true, username, token };
}

async function requireAdminAuthByToken(token) {
  const normalized = (token || "").trim();
  if (!normalized) return { ok: false };
  if (adminLocalMode) {
    const session = adminLocalSessions.get(normalized);
    if (!session) return { ok: false };
    if (session.expiresAt <= Date.now()) {
      adminLocalSessions.delete(normalized);
      return { ok: false };
    }
    return { ok: true, username: session.username, token: normalized };
  }
  const username = await redisClient.get(buildAdminSessionKey(normalized));
  if (!username) return { ok: false };
  return { ok: true, username, token: normalized };
}

/**
 * 解析 Bearer Token
 */
function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

/**
 * 生成指定长度的随机字符串
 */
function randomString(length) {
  return crypto.randomBytes(length).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, length);
}

async function readTailLinesFromFile(filePath, maxLines) {
  if (!filePath) return { lines: [], exists: false };
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return { lines: [], exists: false };
    if (stats.size <= 0) return { lines: [], exists: true };
    const readBytes = Math.min(stats.size, runtimeLogReadBytes);
    const fd = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      await fd.read(buffer, 0, readBytes, stats.size - readBytes);
      const raw = buffer.toString("utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      return { lines: lines.slice(-maxLines), exists: true };
    } finally {
      await fd.close();
    }
  } catch {
    return { lines: [], exists: false };
  }
}

async function getRuntimeLogLines(source, limit) {
  const files = {
    backend: backendMirrorLogFile,
    nginx_access: nginxAccessLogFile,
    nginx_error: nginxErrorLogFile
  };
  const memoryLines = adminLogBuffer.slice(-limit).map((item) => {
    const detail = item?.detail ? ` ${JSON.stringify(item.detail)}` : "";
    return `[admin:${item.level}] ${item.time} ${item.message}${detail}`;
  });
  if (source === "admin") {
    return {
      source,
      files,
      lines: memoryLines.slice(-limit),
      sourceCounts: { admin: Math.min(memoryLines.length, limit) },
      missingSources: []
    };
  }
  if (source in files) {
    const result = await readTailLinesFromFile(files[source], limit);
    return {
      source,
      files,
      lines: result.lines,
      sourceCounts: { [source]: result.lines.length },
      missingSources: result.exists ? [] : [source]
    };
  }
  const backendResult = await readTailLinesFromFile(files.backend, limit);
  const accessResult = await readTailLinesFromFile(files.nginx_access, limit);
  const errorResult = await readTailLinesFromFile(files.nginx_error, limit);
  const backendLines = backendResult.lines;
  const accessLines = accessResult.lines;
  const errorLines = errorResult.lines;
  const merged = [
    ...backendLines.map((line) => `[backend] ${line}`),
    ...accessLines.map((line) => `[nginx-access] ${line}`),
    ...errorLines.map((line) => `[nginx-error] ${line}`),
    ...memoryLines.map((line) => `[admin-buffer] ${line}`)
  ];
  const missingSources = [];
  if (!backendResult.exists) missingSources.push("backend");
  if (!accessResult.exists) missingSources.push("nginx_access");
  if (!errorResult.exists) missingSources.push("nginx_error");
  return {
    source: "all",
    files,
    lines: merged,
    sourceCounts: {
      backend: backendLines.length,
      nginx_access: accessLines.length,
      nginx_error: errorLines.length,
      admin: memoryLines.length
    },
    missingSources
  };
}

async function getScriptFailures(limit) {
  if (!redisReady) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const items = await redisClient.lRange("script:failures", 0, safeLimit - 1);
  return items.map((item) => safeJson(item)).filter(Boolean);
}

async function getSchoolStatus(schoolId) {
  const queueKey = buildQueueKey(schoolId);
  const queueLength = await redisClient.lLen(queueKey);
  const state = await getSchoolState(schoolId);
  const latestFailureRaw = await redisClient.lRange("script:failures", 0, 0);
  const latestFailure = latestFailureRaw.length > 0 ? safeJson(latestFailureRaw[0]) : null;
  return {
    queueLength,
    state,
    latestFailure
  };
}

/**
 * 获取学校级软锁并启动租约续租
 */
/**
 * 为指定学校获取分布式软锁（带自动续期功能）
 * 解决问题：避免多个进程/线程同时处理同一个学校的队列导致数据竞争
 * @param {string} key Redis 中的锁键名
 * @param {string} token 唯一锁标识，防止误删他人的锁
 * @param {number} ttlMs 锁的初始过期时间
 */
async function acquireSchoolLease(key, token, ttlMs) {
  const result = await redisClient.set(key, token, { NX: true, PX: ttlMs });
  if (!result) return { acquired: false, renewTimer: null };
  const renewInterval = Math.max(5000, Math.floor(ttlMs * 0.6));
  const renewTimer = setInterval(async () => {
    await renewSchoolLease(key, token, ttlMs);
  }, renewInterval);
  return { acquired: true, renewTimer };
}

/**
 * 续租锁，避免长流程导致锁过期
 */
/**
 * 续期学校的分布式软锁
 * 由定时器触发，确保长耗时任务（如 LLM 调用）不会导致锁意外过期
 */
async function renewSchoolLease(key, token, ttlMs) {
  const value = await redisClient.get(key);
  if (value !== token) return;
  await redisClient.pExpire(key, ttlMs);
}

/**
 * 释放学校级软锁并停止续租
 */
/**
 * 释放学校的分布式软锁，并清理自动续期定时器
 */
async function releaseSchoolLease(key, token, renewTimer) {
  if (renewTimer) clearInterval(renewTimer);
  const value = await redisClient.get(key);
  if (value === token) {
    await redisClient.del(key);
  }
}

/**
 * 内容脱敏清洗
 * 识别并替换用户提交的教务 HTML/JSON 中的敏感信息
 * 如：手机号、身份证号、学号、姓名等，保护用户隐私
 */
function sanitizeContent(content) {
  let result = content || "";
  result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱]");
  result = result.replace(/1\d{10}/g, "[手机号]");
  result = result.replace(/\b\d{17}[\dXx]\b/g, "[身份证]");
  result = result.replace(/\b\d{9,12}\b/g, "[学号]");
  result = result.replace(/(姓名|name)[:：]\s*[^\s<]{2,10}/gi, "$1:[姓名]");
  return result;
}

/**
 * 分析单个用户提交的具体问题类别（通过正则匹配关键字）
 * 分为: login_failed, login_success, timetable_empty, server_error, parse_error, other
 */
function classifyIssueType(content) {
  const text = (content || "").toString();
  if (/登录失败|账号|密码错误|验证码|login failed|auth failed|invalid password/i.test(text)) {
    return "login_failed";
  }
  if (/登录成功|已登录|login success|auth success/i.test(text)) {
    return "login_success";
  }
  if (/课表为空|暂无课程|空白页面|empty timetable|no course/i.test(text)) {
    return "timetable_empty";
  }
  if (/500|502|503|504|接口异常|服务异常|server error|gateway/i.test(text)) {
    return "server_error";
  }
  if (/解析失败|解析异常|脚本错误|json 解析|parse error|script error/i.test(text)) {
    return "parse_error";
  }
  return "other";
}

/**
 * 提取脚本的函数签名特征用于聚类对比
 * 结合了模型标准化的类别、症状、影响范围与触发条件
 */
function buildIssueSignature(normalized, item) {
  const parts = [
    normalized?.category,
    normalized?.symptom,
    normalized?.scope,
    normalized?.trigger
  ].filter(Boolean);
  const joined = parts.join("|");
  if (joined) return joined;
  return (item?.content || "").toString().slice(0, 300);
}

/**
 * 对提取出的文本进行分词处理（字符级，过滤无用标点）
 * 返回字符 Set，用于计算 Jaccard 相似度
 */
function tokenizeText(text) {
  const cleaned = (text || "")
    .toString()
    .replace(/[\s.,，。;；:：'"“”‘’/\\\-\[\]【】<>《》、|_]+/g, "");
  return new Set(cleaned.split("").filter(Boolean));
}

/**
 * 计算两个字符集合的 Jaccard 相似度
 * 用于文本聚类，判断两条用户提交的问题是否高度相似
 */
function calcSimilarity(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return 0;
  let intersect = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersect += 1;
  }
  const union = tokensA.size + tokensB.size - intersect;
  if (!union) return 0;
  return intersect / union;
}

/**
 * 构建语义聚类
 * 将标准化后的问题按类别分组，然后在组内基于内容相似度(Jaccard)聚类为多个簇
 * 避免不同原因导致的问题被混淆在同一次修复请求中
 */
function buildSemanticClusters(items, normalizedIssues, similarityThreshold) {
  const entries = items.map((item, index) => ({
    item,
    normalized: normalizedIssues?.[index] || {}
  }));
  const categoryGroups = new Map();
  for (const entry of entries) {
    const category = entry.normalized?.category || classifyIssueType(entry.item?.content || "");
    if (!categoryGroups.has(category)) categoryGroups.set(category, []);
    categoryGroups.get(category).push(entry);
  }
  const clusters = [];
  for (const group of categoryGroups.values()) {
    const groupClusters = [];
    for (const entry of group) {
      const signature = buildIssueSignature(entry.normalized, entry.item);
      const tokens = tokenizeText(signature);
      let matched = null;
      let bestScore = 0;
      for (const cluster of groupClusters) {
        const score = calcSimilarity(tokens, cluster.tokens);
        if (score >= similarityThreshold && score >= bestScore) {
          matched = cluster;
          bestScore = score;
        }
      }
      if (matched) {
        matched.items.push(entry);
        for (const token of tokens) {
          matched.tokens.add(token);
        }
      } else {
        groupClusters.push({ items: [entry], tokens: new Set(tokens) });
      }
    }
    for (const cluster of groupClusters) {
      clusters.push(cluster.items);
    }
  }
  return clusters;
}

function splitQueueByIssueType(queue) {
  const result = {};
  for (const item of queue) {
    const type = classifyIssueType(item?.content || "");
    if (!result[type]) result[type] = [];
    result[type].push(item);
  }
  return result;
}

function buildScriptPath(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return path.join(scriptOutputDir, safeName);
}

function buildScriptMetaPath(scriptName) {
  return path.join(scriptOutputDir, buildScriptMetaFileName(scriptName));
}

/**
 * 构建脚本 meta 文件名（不含目录）
 */
function buildScriptMetaFileName(scriptName) {
  const safeName = sanitizeScriptName(scriptName).replace(/\.js$/i, "");
  return `${safeName}.meta.json`;
}

function sanitizeScriptName(scriptName) {
  const name = (scriptName || "").replace(/[\\/]/g, "_").trim();
  if (name.toLowerCase().endsWith(".js")) return name;
  return `${name || "unknown"}.js`;
}

function normalizeSchoolSystemType(value) {
  const text = (value || "").toString().trim().toLowerCase();
  if (!text) return "";
  if (text.includes("正方") || text.includes("zhengfang") || text === "zf") return "zhengfang";
  if (text.includes("强智") || text.includes("qiangzhi")) return "qiangzhi";
  if (text.includes("青果") || text.includes("kingosoft")) return "kingosoft";
  if (text.includes("超星") || text.includes("chaoxing") || text.includes("学习通")) {
    return "chaoxing";
  }
  if (text.includes("未知") || text.includes("unknown")) return "unknown";
  return text;
}

function detectSchoolSystemType(content) {
  const text = (content || "").toString();
  if (/正方|zhengfang|jwglxt|zfwz/i.test(text)) return "zhengfang";
  if (/强智|qiangzhi/i.test(text)) return "qiangzhi";
  if (/青果|kingosoft/i.test(text)) return "kingosoft";
  if (/超星|chaoxing|学习通/i.test(text)) return "chaoxing";
  return "unknown";
}

function detectSchoolSystemTypeFromUrl(sourceUrl) {
  const text = (sourceUrl || "").toString().trim().toLowerCase();
  if (!text) return "";
  if (/jwglxt|zhengfang|zfjw/.test(text)) return "zhengfang";
  if (/qiangzhi|qzjw|jwmanage/.test(text)) return "qiangzhi";
  if (/kingosoft|qingguo/.test(text)) return "kingosoft";
  if (/chaoxing|xuexitong|superstar/.test(text)) return "chaoxing";
  return "";
}

function normalizeSubmissionFailureType(value) {
  const text = (value || "").toString().trim().toLowerCase();
  if (!text) return "";
  if (text === "parser_crash" || text === "parsercrash") return "parser_crash";
  if (text === "parser_empty" || text === "parserempty") return "parser_empty";
  if (text === "extractor_empty" || text === "extractorempty") return "extractor_empty";
  if (text === "unsupported_format" || text === "unsupportedformat") return "unsupported_format";
  if (text === "login_required" || text === "loginrequired") return "login_required";
  if (text === "captcha_required" || text === "captcharequired") return "captcha_required";
  if (text === "non_timetable" || text === "nontimetable") return "non_timetable";
  if (text === "unknown") return "unknown";
  return "";
}

function normalizeFinalResult(value) {
  const text = (value || "").toString().trim().toLowerCase();
  if (text === "success" || text === "succeeded") return "success";
  if (text === "failed" || text === "failure" || text === "error") return "failed";
  return "";
}

function mapFailureCategory(failureType) {
  switch (failureType) {
    case "login_required":
    case "captcha_required":
      return "page_state";
    case "parser_crash":
    case "parser_empty":
      return "parser_failure";
    case "extractor_empty":
    case "unsupported_format":
    case "non_timetable":
      return "content_state";
    default:
      return "unknown";
  }
}

function detectSubmissionSignals(content, sourceUrl) {
  const text = `${content || ""}\n${sourceUrl || ""}`;
  const hasHtml = /<\/?(html|body|table|div|span|script|form|input)[^>]*>/i.test(text);
  const loginLike =
    /(?:^|[^a-z])(login|signin|cas|sso)(?:[^a-z]|$)/i.test(text) ||
    /\u767b\u5f55|\u7528\u6237\u540d|\u5bc6\u7801|\u7edf\u4e00\u8eab\u4efd\u8ba4\u8bc1/.test(text);
  const captchaLike =
    /captcha|checkcode|verifycode|validcode/i.test(text) ||
    /\u9a8c\u8bc1\u7801|\u56fe\u5f62\u6821\u9a8c/.test(text);
  const timetableLike =
    /courseName|courseTable|kbList|scheduleHtmlParser|xskbcx|timeTable|weekday/i.test(text) ||
    /\u8bfe\u8868|\u8bfe\u7a0b\u8868|\u4e0a\u8bfe\u65f6\u95f4|\u5468\u6b21|\u8282\u6b21|\u6559\u5b66\u73ed|\u8bfe\u7a0b\u5b89\u6392|\u661f\u671f[\u4e00-\u65e5\u5929]/.test(
      text
    );
  return {
    hasHtml,
    loginLike,
    captchaLike,
    timetableLike,
    systemFromUrl: detectSchoolSystemTypeFromUrl(sourceUrl),
    systemFromContent: detectSchoolSystemType(content)
  };
}

function classifyFailureByRule({ content, sourceUrl, failureTypeInput, attemptedParsers }) {
  const normalizedInput = normalizeSubmissionFailureType(failureTypeInput);
  if (normalizedInput) {
    return {
      failureType: normalizedInput,
      failureCategory: mapFailureCategory(normalizedInput),
      failureSource: "client",
      confident: normalizedInput !== "unknown"
    };
  }
  const signals = detectSubmissionSignals(content, sourceUrl);
  const trimmed = (content || "").toString().trim();
  if (!trimmed) {
    return {
      failureType: "extractor_empty",
      failureCategory: mapFailureCategory("extractor_empty"),
      failureSource: "rule",
      confident: true
    };
  }
  if (!signals.hasHtml && trimmed.length < 80) {
    return {
      failureType: "extractor_empty",
      failureCategory: mapFailureCategory("extractor_empty"),
      failureSource: "rule",
      confident: true
    };
  }
  if (signals.captchaLike) {
    return {
      failureType: "captcha_required",
      failureCategory: mapFailureCategory("captcha_required"),
      failureSource: "rule",
      confident: true
    };
  }
  if (signals.loginLike && !signals.timetableLike) {
    return {
      failureType: "login_required",
      failureCategory: mapFailureCategory("login_required"),
      failureSource: "rule",
      confident: true
    };
  }
  if (!signals.timetableLike) {
    return {
      failureType: "non_timetable",
      failureCategory: mapFailureCategory("non_timetable"),
      failureSource: "rule",
      confident: signals.hasHtml
    };
  }
  if (Array.isArray(attemptedParsers) && attemptedParsers.length > 0) {
    return {
      failureType: "parser_empty",
      failureCategory: mapFailureCategory("parser_empty"),
      failureSource: "rule",
      confident: true
    };
  }
  return {
    failureType: "unsupported_format",
    failureCategory: mapFailureCategory("unsupported_format"),
    failureSource: "rule",
    confident: false
  };
}

function isSummaryProviderReady() {
  if (summaryProvider === "gemini") {
    return Boolean(summaryApiKey);
  }
  return Boolean(summaryApiKey);
}

async function classifyFailureByModel({
  content,
  sourceUrl,
  attemptedParsers,
  scriptName,
  ruleFailureType,
  schoolSystemType
}) {
  if (!isSummaryProviderReady()) return null;
  const systemPrompt =
    "你是教务解析失败分类助手，只输出 JSON 对象。" +
    '字段仅允许：failureType, schoolSystemType, confidence。' +
    'failureType 仅允许：parser_crash, parser_empty, extractor_empty, unsupported_format, login_required, captcha_required, non_timetable, unknown。' +
    'schoolSystemType 仅允许：zhengfang, qiangzhi, kingosoft, chaoxing, unknown。';
  const userPrompt =
    "请结合以下上下文判断失败原因与教务系统类型，不要输出额外说明。\n" +
    JSON.stringify({
      sourceUrl: (sourceUrl || "").toString().slice(0, 400),
      attemptedParsers: Array.isArray(attemptedParsers) ? attemptedParsers.slice(0, 6) : [],
      scriptName: sanitizeScriptName(scriptName || "").slice(0, 120),
      ruleFailureType: normalizeSubmissionFailureType(ruleFailureType) || "unknown",
      schoolSystemType: normalizeSchoolSystemType(schoolSystemType) || "unknown",
      contentPreview: (content || "").toString().slice(0, 2400)
    });
  const rawText =
    summaryProvider === "gemini"
      ? await callGemini(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        })
      : await callOpenAICompatible(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl,
          usageType: "summary",
          extra: summaryRequestExtra,
          apiStyle: summaryApiStyleRaw
        });
  const objectText = sliceJson(rawText?.text || "", "{", "}");
  const parsed = objectText ? safeJson(objectText) : null;
  if (!parsed || typeof parsed !== "object") return null;
  const failureType = normalizeSubmissionFailureType(parsed.failureType) || "unknown";
  const inferredSystem = normalizeSchoolSystemType(parsed.schoolSystemType) || "unknown";
  const confidence = Number(parsed.confidence || 0);
  return {
    failureType,
    schoolSystemType: inferredSystem,
    confidence: Number.isFinite(confidence) ? confidence : 0
  };
}

function resolveSchoolSystemTypeWithEvidence(content, input, sourceUrl, inferredHint = "") {
  const normalizedInput = normalizeSchoolSystemType(input);
  if (normalizedInput) {
    return { schoolSystemType: normalizedInput, schoolSystemSource: "client" };
  }
  const fromUrl = detectSchoolSystemTypeFromUrl(sourceUrl);
  if (fromUrl) {
    return { schoolSystemType: fromUrl, schoolSystemSource: "url" };
  }
  const fromContent = detectSchoolSystemType(content);
  if (fromContent && fromContent !== "unknown") {
    return { schoolSystemType: fromContent, schoolSystemSource: "content" };
  }
  const fromHint = normalizeSchoolSystemType(inferredHint);
  if (fromHint) {
    return { schoolSystemType: fromHint, schoolSystemSource: "model" };
  }
  return { schoolSystemType: "unknown", schoolSystemSource: "unknown" };
}

async function resolveSubmissionClassification({
  content,
  sourceUrl,
  failureTypeInput,
  schoolSystemTypeInput,
  attemptedParsers,
  scriptName
}) {
  const rule = classifyFailureByRule({
    content,
    sourceUrl,
    failureTypeInput,
    attemptedParsers
  });
  let modelResult = null;
  if (!rule.confident || !normalizeSchoolSystemType(schoolSystemTypeInput)) {
    modelResult = await classifyFailureByModel({
      content,
      sourceUrl,
      attemptedParsers,
      scriptName,
      ruleFailureType: rule.failureType,
      schoolSystemType: schoolSystemTypeInput
    });
  }
  const modelFailureType = normalizeSubmissionFailureType(modelResult?.failureType);
  const failureType =
    modelFailureType && (!rule.confident || rule.failureType === "unsupported_format" || rule.failureType === "unknown")
      ? modelFailureType
      : rule.failureType;
  const failureSource =
    modelFailureType && failureType === modelFailureType && failureType !== rule.failureType
      ? "model"
      : rule.failureSource;
  const failureCategory = mapFailureCategory(failureType);
  const schoolSystem = resolveSchoolSystemTypeWithEvidence(
    content,
    schoolSystemTypeInput,
    sourceUrl,
    modelResult?.schoolSystemType || ""
  );
  return {
    failureType: failureType || "unknown",
    failureCategory,
    failureSource,
    schoolSystemType: schoolSystem.schoolSystemType || "unknown",
    schoolSystemSource: schoolSystem.schoolSystemSource || "unknown"
  };
}

function resolveSchoolSystemType(content, input) {
  return resolveSchoolSystemTypeWithEvidence(content, input, "", "").schoolSystemType;
}

function extractSchoolNameFromContent(content) {
  const raw = (content || "").toString();
  if (!raw) return "";
  const titleMatch = raw.match(/<title[^>]*>([^<]{2,120})<\/title>/i);
  if (titleMatch?.[1]) {
    const fromTitle = extractSchoolNameFromText(titleMatch[1]);
    if (fromTitle) return fromTitle;
  }
  const roughText = raw.replace(/<[^>]+>/g, " ");
  return extractSchoolNameFromText(roughText);
}

function extractCandidateUrls(rawContent, sanitizedContent, sourceUrl) {
  const text = `${rawContent || ""}\n${sanitizedContent || ""}\n${sourceUrl || ""}`;
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const matches = text.match(urlRegex) || [];
  const list = [];
  if (sourceUrl) {
    list.push(sourceUrl);
  }
  for (const item of matches) {
    const value = (item || "").trim();
    if (!value) continue;
    list.push(value);
  }
  return mergeDistinctUrls([], list).slice(0, 12);
}

function mergeDistinctUrls(existing, incoming) {
  const map = new Map();
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    const text = (raw || "").toString().trim();
    if (!text) continue;
    let parsed = null;
    try {
      parsed = new URL(text);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    parsed.hash = "";
    const key = parsed.toString();
    if (!map.has(key)) {
      map.set(key, key);
    }
  }
  return Array.from(map.values());
}

function extractSchoolNameFromText(text) {
  const value = (text || "").toString().replace(/\s+/g, "");
  if (!value) return "";
  const patterns = [
    /(?:学校|school)[：:\-]?\s*([^\s<]{2,40}(?:高等专科学校|职业技术学院|职业学院|技术学院|科技学院|师范大学|师范学院|医学院|中医药大学|外国语大学|外语学院|信息工程学院|信息工程大学|交通大学|工业大学|科技大学|财经大学|农业大学|理工大学|大学|学院))/i,
    /([\u4e00-\u9fa5]{2,40}(?:高等专科学校|职业技术学院|职业学院|技术学院|科技学院|师范大学|师范学院|医学院|中医药大学|外国语大学|外语学院|信息工程学院|信息工程大学|交通大学|工业大学|科技大学|财经大学|农业大学|理工大学|大学|学院))/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const candidate = (match?.[1] || "").toString().trim();
    if (candidate) return candidate;
  }
  return "";
}

function normalizeSchoolNameKey(value) {
  // 归一化学校名称：去噪、去括号、去标点、统一小写
  let text = (value || "").toString().trim();
  if (!text) return "";
  text = text.replace(/（[^）]{0,20}）/g, "");
  text = text.replace(/\([^)]{0,20}\)/g, "");
  text = text.replace(/[\s·•・.,，。;；:：'"“”‘’/\\\-\[\]【】<>《》、|_]+/g, "");
  text = text.toLowerCase();
  const suffixes = [
    "高等专科学校",
    "职业技术学院",
    "职业学院",
    "技术学院",
    "科技学院",
    "师范大学",
    "师范学院",
    "医学院",
    "中医药大学",
    "外国语大学",
    "外语学院",
    "信息工程学院",
    "信息工程大学",
    "交通大学",
    "工业大学",
    "科技大学",
    "财经大学",
    "农业大学",
    "理工大学",
    "大学",
    "学院"
  ];
  let trimmed = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (trimmed.endsWith(suffix)) {
        trimmed = trimmed.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  // 优先返回裁剪后的核心名称，避免过度归一化导致信息丢失
  return trimmed || text;
}

function normalizeSchoolNameFull(value) {
  // 归一化学校名称（保留后缀）：用于生成稳定且不易冲突的 schoolId
  // 注意：只做去噪与格式统一，不做“大学/学院”等后缀裁剪，避免不同学校被错误合并
  let text = (value || "").toString().trim();
  if (!text) return "";
  text = text.replace(/（[^）]{0,40}）/g, "");
  text = text.replace(/\([^)]{0,40}\)/g, "");
  text = text.replace(/[\s·•・.,，。;；:：'"“”‘’/\\\-\[\]【】<>《》、|_]+/g, "");
  return text.toLowerCase();
}

function buildNameBigrams(text) {
  // 生成双字片段集合，避免仅靠单字造成误判
  const value = (text || "").toString();
  if (value.length <= 1) return new Set([value]);
  const result = new Set();
  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }
  return result;
}

function calcSchoolNameSimilarity(a, b) {
  // 相似度计算：Jaccard + 长度惩罚 + 包含关系加分
  if (!a || !b) return 0;
  if (a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen <= 1) return 0;
  const aSet = buildNameBigrams(a);
  const bSet = buildNameBigrams(b);
  let intersection = 0;
  for (const value of aSet) {
    if (bSet.has(value)) intersection += 1;
  }
  const union = aSet.size + bSet.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containsBonus = a.includes(b) || b.includes(a) ? 0.12 : 0;
  const lengthPenalty = maxLen > 0 ? Math.max(0, 1 - Math.abs(a.length - b.length) / maxLen) : 0;
  return Math.min(1, jaccard * 0.85 + lengthPenalty * 0.15 + containsBonus);
}

async function getSchoolAliasMapCached() {
  // 优先走内存缓存，降低 Redis 压力
  const now = Date.now();
  if (schoolAliasCache.map.size > 0 && now - schoolAliasCache.updatedAt < schoolAliasCacheMs) {
    return schoolAliasCache.map;
  }
  const raw = await redisClient.hGetAll("school:alias");
  const map = new Map();
  for (const [alias, schoolId] of Object.entries(raw)) {
    if (!alias || !schoolId) continue;
    map.set(alias, schoolId);
  }
  schoolAliasCache = {
    updatedAt: now,
    map
  };
  return map;
}

async function resolveSchoolIdByFuzzyName(normalizedName) {
  // 模糊匹配只在名称足够长时启用，避免过短误归类
  if (!normalizedName || normalizedName.length < schoolFuzzyMinLength) return "";
  // 命中缓存直接返回，避免重复计算
  const cached = await redisClient.get(`school:fuzzy:${normalizedName}`);
  if (cached) return cached;
  const aliasMap = await getSchoolAliasMapCached();
  let bestId = "";
  let bestScore = 0;
  for (const [alias, schoolId] of aliasMap.entries()) {
    if (!alias || !schoolId) continue;
    const score = calcSchoolNameSimilarity(normalizedName, alias);
    if (score > bestScore) {
      bestScore = score;
      bestId = schoolId;
    }
  }
  if (bestScore >= schoolFuzzyThreshold && bestId) {
    // 模糊命中后写入缓存，提升后续命中效率
    await redisClient.set(`school:fuzzy:${normalizedName}`, bestId, { EX: schoolFuzzyCacheTtlSec });
    return bestId;
  }
  return "";
}

function resolveBestSchoolName(existingName, incomingName) {
  // 取更完整的学校名称，便于后续展示与别名映射
  const incoming = (incomingName || "").toString().trim();
  const existing = (existingName || "").toString().trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  return incoming.length >= existing.length ? incoming : existing;
}

async function saveSchoolAlias(schoolId, schoolName) {
  // 用归一化名称写入别名映射，统一归类入口
  if (!redisReady) return;
  if (!schoolId || !schoolName) return;
  const normalizedFull = normalizeSchoolNameFull(schoolName);
  const normalizedTrimmed = normalizeSchoolNameKey(schoolName);
  if (normalizedFull) {
    await redisClient.hSet("school:alias", normalizedFull, schoolId);
  }
  if (normalizedTrimmed && normalizedTrimmed !== normalizedFull) {
    await redisClient.hSet("school:alias", normalizedTrimmed, schoolId);
  }
}

/**
 * 解析和记录学校信息，将别名/模糊名称映射为统一的 schoolId
 * - 结合强智/正方/超星等教务类型作为判断依据
 * - 利用缓存机制减少频繁查库
 */
async function resolveSchoolIdByName(schoolIdInput, schoolNameInput) {
  // 优先使用上报的 schoolId，保证强一致归类
  const rawId = (schoolIdInput || "").toString().trim();
  if (rawId) {
    await saveSchoolAlias(rawId, schoolNameInput);
    return rawId;
  }
  // Redis 不可用时只做本地归一化兜底，避免阻塞主流程
  if (!redisReady) {
    return normalizeSchoolNameFull(schoolNameInput);
  }
  // schoolId 缺失时使用“保留后缀”的归一化名称作为主键，避免不同学校被合并
  const normalizedFull = normalizeSchoolNameFull(schoolNameInput);
  if (!normalizedFull) return "";
  const normalizedTrimmed = normalizeSchoolNameKey(schoolNameInput);
  // 先走精确别名命中（优先 full，其次 trimmed）
  const existingFull = await redisClient.hGet("school:alias", normalizedFull);
  if (existingFull) return existingFull;
  if (normalizedTrimmed && normalizedTrimmed !== normalizedFull) {
    const existingTrim = await redisClient.hGet("school:alias", normalizedTrimmed);
    if (existingTrim) return existingTrim;
  }
  // 再走模糊匹配命中，成功后写回别名
  const fuzzyMatched = await resolveSchoolIdByFuzzyName(normalizedFull);
  if (fuzzyMatched) {
    await redisClient.hSet("school:alias", normalizedFull, fuzzyMatched);
    if (normalizedTrimmed && normalizedTrimmed !== normalizedFull) {
      await redisClient.hSet("school:alias", normalizedTrimmed, fuzzyMatched);
    }
    return fuzzyMatched;
  }
  // 兜底：将归一化名称自身作为 schoolId，并写入别名，确保后续可稳定命中
  await redisClient.hSet("school:alias", normalizedFull, normalizedFull);
  if (normalizedTrimmed && normalizedTrimmed !== normalizedFull) {
    await redisClient.hSet("school:alias", normalizedTrimmed, normalizedFull);
  }
  return normalizedFull;
}

async function saveSchoolInfo(schoolId, schoolName, schoolSystemType, urls = [], options = {}) {
  // 维护学校基础信息，便于面板展示与统计
  if (!schoolId) return;
  const key = "school:info";
  const existingRaw = await redisClient.hGet(key, schoolId);
  const existing = existingRaw ? safeJson(existingRaw) : null;
  const resolvedSchoolName = resolveBestSchoolName(existing?.schoolName, schoolName);
  const mergedUrls = mergeDistinctUrls(existing?.urls, urls).slice(0, 20);
  const primaryUrl = mergedUrls[0] || "";
  const payload = {
    schoolId,
    schoolName: resolvedSchoolName,
    schoolSystemType: schoolSystemType || existing?.schoolSystemType || "unknown",
    systemSource: (options?.systemSource || existing?.systemSource || "").toString(),
    primaryUrl,
    urls: mergedUrls,
    updatedAt: Date.now()
  };
  await redisClient.hSet(key, schoolId, JSON.stringify(payload));
  // 同步写入别名，确保后续模糊/精确匹配可归并
  await saveSchoolAlias(schoolId, resolvedSchoolName);
}

async function getSchoolInfoMap() {
  const raw = await redisClient.hGetAll("school:info");
  const result = {};
  for (const [schoolId, value] of Object.entries(raw)) {
    const info = safeJson(value) || {};
    result[schoolId] = {
      schoolId,
      schoolName: info.schoolName || "",
      schoolSystemType: normalizeSchoolSystemType(info.schoolSystemType) || "unknown",
      systemSource: (info.systemSource || "").toString(),
      primaryUrl: info.primaryUrl || "",
      urls: Array.isArray(info.urls) ? info.urls : [],
      updatedAt: Number(info.updatedAt || 0)
    };
  }
  return result;
}

function buildTaskKey(taskId) {
  return `task:${taskId}`;
}

function buildQueueKey(schoolId) {
  return `queue:${schoolId}`;
}

function buildSchoolStateKey(schoolId) {
  return `school:state:${schoolId}`;
}

function buildSchoolLockKey(schoolId) {
  return `school:lock:${schoolId}`;
}

function buildSchoolMetricKey(schoolId) {
  return `school:metrics:${schoolId}`;
}

function buildDedupKey(schoolId, hash) {
  return `dedup:${schoolId}:${hash}`;
}

/**
 * 生成请求幂等键，避免短时间内重复创建任务
 */
/**
 * 构建提交任务的幂等键，避免短时间内同一设备/同一版本的重复提交被多次处理
 * 幂等键组成：schoolId + scriptName + contentHash + scriptHash + clientVersion
 */
function buildIdempotentKey({ schoolId, scriptName, contentHash, scriptHash, clientVersion }) {
  const safeSchoolId = schoolId || "unknown";
  const safeScriptName = sanitizeScriptName(scriptName || "unknown");
  const safeContentHash = contentHash || "";
  const safeScriptHash = scriptHash || "";
  const safeClientVersion = clientVersion || "";
  return `idem:${safeSchoolId}:${safeScriptName}:${safeContentHash}:${safeScriptHash}:${safeClientVersion}`;
}

function buildMetricKey(type) {
  return `metrics:${type}`;
}

/**
 * 管理后台账号 Redis Key
 */
function buildAdminCredentialKey() {
  return "admin:credentials";
}

function buildAdminUsersKey() {
  return "admin:users";
}

/**
 * 管理后台会话 Redis Key
 */
function buildAdminSessionKey(token) {
  return `admin:session:${token}`;
}

function buildScriptHistoryKey(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:history:${safeName}`;
}

async function pushScriptHistory(scriptName, entry) {
  if (!redisReady) return;
  const safeName = sanitizeScriptName(scriptName);
  if (!safeName) return;
  const key = buildScriptHistoryKey(safeName);
  const payload = {
    ...entry,
    scriptName: safeName,
    createdAt: entry?.createdAt || Date.now()
  };
  const raw = JSON.stringify(payload);
  await redisClient.lPush(key, raw);
  await redisClient.lTrim(key, 0, Math.max(0, scriptHistoryLimit - 1));
}

async function getScriptHistory(scriptName, limit) {
  if (!redisReady) return [];
  const safeName = sanitizeScriptName(scriptName);
  if (!safeName) return [];
  const key = buildScriptHistoryKey(safeName);
  const items = await redisClient.lRange(key, 0, Math.max(0, limit - 1));
  return (items || []).map((raw) => safeJson(raw) || null).filter(Boolean);
}

async function listAdminScripts() {
  let entries = [];
  try {
    entries = await fs.readdir(scriptOutputDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const names = new Set();
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue;
    const name = entry.name || "";
    if (name.endsWith(".meta.json")) {
      const base = name.replace(/\.meta\.json$/i, "");
      if (base) names.add(`${base}.js`);
      continue;
    }
    if (name.endsWith(".js") && !name.includes(".bak.")) {
      names.add(name);
    }
  }
  const failures = await getScriptFailures(200);
  const recentFailureCount = {};
  for (const item of failures || []) {
    const name = (item?.scriptName || "").toString();
    if (!name) continue;
    recentFailureCount[name] = (recentFailureCount[name] || 0) + 1;
  }
  const list = await Promise.all(
    Array.from(names).map(async (scriptName) => {
      const meta = await getScriptMeta(scriptName);
      const pendingContent = await loadPendingScript(scriptName);
      const pendingAvailable = Boolean(pendingContent);
      const rollbackTargetVersion = Number(meta?.parentVersion || 0);
      const rollbackContent = rollbackTargetVersion
        ? await loadScriptBackup(scriptName, rollbackTargetVersion)
        : "";
      const rollbackAvailable = Boolean(rollbackContent);
      return {
        scriptName,
        meta,
        pendingAvailable,
        rollbackAvailable,
        rollbackTargetVersion,
        recentFailureCount: recentFailureCount[sanitizeScriptName(scriptName)] || 0
      };
    })
  );
  list.sort((a, b) => Number(b?.meta?.updatedAt || 0) - Number(a?.meta?.updatedAt || 0));
  return list;
}

function buildUsageKey(type) {
  return `usage:${type}`;
}

function buildScriptMetaKey(scriptName) {
  return `script:meta:${sanitizeScriptName(scriptName)}`;
}

async function httpGetJson(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers
      },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const text = await response.text();
    return safeJson(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 发送 JSON 请求
 */
async function httpPostJson(url, body, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 从模型输出中提取 JSON 数组
 */
function extractJsonArray(text) {
  const arrayText = sliceJson(text, "[", "]");
  if (arrayText) {
    const parsed = safeJson(arrayText);
    if (Array.isArray(parsed)) {
      const normalized = normalizeParsedCourses(parsed);
      if (normalized.ok) return JSON.stringify(normalized.courses);
    }
  }
  const objectText = sliceJson(text, "{", "}");
  if (objectText) {
    const parsed = safeJson(objectText);
    if (parsed && Array.isArray(parsed.courses)) {
      const normalized = normalizeParsedCourses(parsed.courses);
      if (normalized.ok) return JSON.stringify(normalized.courses);
    }
  }
  return null;
}

/**
 * 标准化模型输出课程数组，确保端侧可直接消费
 */
function normalizeParsedCourses(courses) {
  if (!Array.isArray(courses)) return { ok: false, reason: "输出不是数组" };
  if (courses.length === 0) return { ok: true, courses: [] };
  const normalized = [];
  for (const item of courses) {
    const row = normalizeParsedCourseItem(item);
    if (row) normalized.push(row);
  }
  if (normalized.length === 0) {
    return { ok: false, reason: "课程字段无效" };
  }
  return { ok: true, courses: normalized };
}

/**
 * 标准化单条课程结构
 */
function normalizeParsedCourseItem(item) {
  if (!item || typeof item !== "object") return null;
  const name = (item.name || "").toString().trim();
  const dayOfWeek = toInt(item.dayOfWeek);
  const startSection = toInt(item.startSection);
  const duration = toInt(item.duration);
  const startWeek = toInt(item.startWeek);
  const endWeek = toInt(item.endWeek);
  const weekType = toInt(item.weekType);
  if (!name) return null;
  if (dayOfWeek < 1 || dayOfWeek > 7) return null;
  if (startSection < 1 || duration < 1) return null;
  if (startWeek < 1 || endWeek < startWeek) return null;
  if (![0, 1, 2].includes(weekType)) return null;
  return {
    name,
    teacher: (item.teacher || "").toString().trim(),
    location: (item.location || "").toString().trim(),
    dayOfWeek,
    startSection,
    duration,
    startWeek,
    endWeek,
    weekType
  };
}

/**
 * 安全转整数，失败时返回 -1
 */
function toInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt((value || "").toString().trim(), 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

/**
 * 截取可能的 JSON 片段
 */
function sliceJson(text, startChar, endChar) {
  const start = text.indexOf(startChar);
  const end = text.lastIndexOf(endChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1).trim();
}

/**
 * 安全解析 JSON
 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 标准化模型名称，处理常见缩写与后缀格式
 * 例如：glm5 -> glm-5, gpt5.2codex -> gpt-5.2-codex
 */
function normalizeModelName(name) {
  if (!name) return "";
  const raw = String(name).trim();
  if (!raw) return "";
  let value = raw.toLowerCase().replace(/[\s_]+/g, "-");
  value = value.replace(/(glm|deepseek|qwen|gemini|gpt)(\d)/g, "$1-$2");
  value = value.replace(/(\d)(codex)/g, "$1-codex");
  value = value.replace(/(\d)(mini|nano|flash|pro|turbo|lite)/g, "$1-$2");
  value = value.replace(/-+codex/g, "-codex");
  value = value.replace(/-+/g, "-");
  return value;
}

/**
 * 解析最终模型名称，优先使用别名映射表 (LLM_MODEL_ALIAS_JSON)，其次使用标准化名称
 */
function resolveModelName(name) {
  if (!name) return "";
  const normalized = normalizeModelName(name);
  if (modelAliasMap && typeof modelAliasMap === "object") {
    if (modelAliasMap[name]) return modelAliasMap[name];
    if (modelAliasMap[normalized]) return modelAliasMap[normalized];
  }
  return normalized || name;
}

/**
 * 根据模型名称前缀自动推断服务提供商
 * 例如：qwen-plus 推断为 qwen，deepseek-chat 推断为 deepseek
 */
function inferProviderFromModel(name) {
  const normalized = normalizeModelName(name);
  if (normalized.startsWith("glm")) return "glm";
  if (normalized.startsWith("deepseek")) return "deepseek";
  if (normalized.startsWith("qwen")) return "qwen";
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("gpt")) return "gpt";
  return "";
}

/**
 * 标准化 Provider 名称，支持 "auto" 自动推断
 */
function normalizeProvider(providerName, modelName) {
  const normalized = (providerName || "").toLowerCase();
  if (!normalized || normalized === "auto") {
    const inferred = inferProviderFromModel(modelName);
    return inferred || "gpt";
  }
  return normalized;
}

/**
 * 标准化 API 风格配置，仅允许 chat 或 responses
 */
function normalizeApiStyle(value) {
  if (!value) return "";
  const normalized = value.toLowerCase();
  if (normalized === "chat" || normalized === "responses") return normalized;
  return "";
}

/**
 * 决定使用的 API 调用风格：
 * GPT-5 及其 codex 系列默认使用 OpenAI 的 Responses API，其余默认使用 Chat Completions
 */
function resolveApiStyle(providerName, modelName) {
  if (providerName === "gpt" || providerName === "openai") {
    const normalized = normalizeModelName(modelName);
    if (normalized.startsWith("gpt-5") || normalized.includes("codex")) {
      return "responses";
    }
  }
  return "chat";
}

/**
 * 合并平台特有的请求体扩展参数（如 response_format, tools 等）
 */
function mergeRequestExtras(baseBody, extraBody) {
  if (!extraBody || typeof extraBody !== "object") return baseBody;
  return { ...baseBody, ...extraBody };
}

/**
 * 从 OpenAI Responses API (非 Chat Completions) 的返回体中提取文本
 */
function extractResponsesText(payload) {
  const output = payload?.output || [];
  const texts = [];
  for (const item of output) {
    const content = item?.content || [];
    for (const part of content) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(part.text);
      }
    }
  }
  if (texts.length) return texts.join("\n");
  return payload?.output_text || payload?.text || "";
}

/**
 * 提取 OpenAI 兼容接口（包括 DeepSeek/Qwen/GLM/GPT）的用量信息
 */
function extractOpenAIUsage(payload) {
  if (!payload) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (payload.usage) {
    const usage = payload.usage;
    const inputTokens =
      usage.prompt_tokens || usage.input_tokens || usage.promptTokens || usage.inputTokens || 0;
    const outputTokens =
      usage.completion_tokens ||
      usage.output_tokens ||
      usage.completionTokens ||
      usage.outputTokens ||
      0;
    const totalTokens =
      usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0;
    return { inputTokens, outputTokens, totalTokens };
  }
  return collectUsageTokens(payload);
}

/**
 * 提取 Gemini 官方接口的用量信息
 */
function extractGeminiUsage(payload) {
  const usage = payload?.usageMetadata || payload?.usage_metadata;
  if (!usage) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const inputTokens = usage.promptTokenCount || usage.inputTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || usage.outputTokenCount || 0;
  const totalTokens = usage.totalTokenCount || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function calculateUsageCost(usageType, usage) {
  if (!usage) return 0;
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  if (usageType === "summary") {
    const inputCost = (inputTokens / 1_000_000) * summaryInputCostPerMTokens;
    const outputCost = (outputTokens / 1_000_000) * summaryOutputCostPerMTokens;
    return inputCost + outputCost;
  }
  if (usageType === "script") {
    const inputCost = (inputTokens / 1_000_000) * scriptInputCostPerMTokens;
    const outputCost = (outputTokens / 1_000_000) * scriptOutputCostPerMTokens;
    return inputCost + outputCost;
  }
  return 0;
}

function buildLocalUsageKey(usageType) {
  return `usage:local:${usageType}`;
}

async function recordLocalUsage(usageType, usage, providerName, modelName) {
  if (!usageType || !redisClient || !usage) return;
  const key = buildLocalUsageKey(usageType);
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const totalTokens = usage.totalTokens || inputTokens + outputTokens;
  const costTotal = calculateUsageCost(usageType, { inputTokens, outputTokens, totalTokens });
  await redisClient.hIncrBy(key, "inputTokens", Math.round(inputTokens));
  await redisClient.hIncrBy(key, "outputTokens", Math.round(outputTokens));
  await redisClient.hIncrBy(key, "tokenTotal", Math.round(totalTokens));
  if (costTotal) {
    await redisClient.hIncrByFloat(key, "costTotal", costTotal);
  }
  await redisClient.hSet(key, "provider", providerName || "");
  await redisClient.hSet(key, "model", modelName || "");
  await redisClient.hSet(key, "updatedAt", Date.now().toString());
}

async function getLocalUsageSnapshot(usageType) {
  if (!redisClient) return null;
  const key = buildLocalUsageKey(usageType);
  const data = await redisClient.hGetAll(key);
  if (!data || Object.keys(data).length === 0) return null;
  return {
    provider: data.provider || "",
    model: data.model || "",
    inputTokens: Number(data.inputTokens || 0),
    outputTokens: Number(data.outputTokens || 0),
    tokenTotal: Number(data.tokenTotal || 0),
    costTotal: Number(data.costTotal || 0),
    currency: "usd",
    updatedAt: Number(data.updatedAt || 0),
    error: ""
  };
}

function formatUsageDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildUsageWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - usageLookbackDays * 24 * 60 * 60 * 1000);
  return {
    startDate: formatUsageDate(start),
    endDate: formatUsageDate(end),
    startTime: Math.floor(start.getTime() / 1000),
    endTime: Math.floor(end.getTime() / 1000)
  };
}

function fillUsageUrl(template, window) {
  if (!template) return "";
  return template
    .replaceAll("{start_date}", window.startDate)
    .replaceAll("{end_date}", window.endDate)
    .replaceAll("{start_time}", String(window.startTime))
    .replaceAll("{end_time}", String(window.endTime));
}

function buildUsageHeaders(providerName, apiKeyValue) {
  if (!apiKeyValue) return {};
  if (providerName === "gemini") {
    return { "x-goog-api-key": apiKeyValue };
  }
  return { Authorization: `Bearer ${apiKeyValue}` };
}

function collectUsageTokens(payload) {
  const result = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const stack = [payload];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "number") {
        const k = key.toLowerCase();
        if (k.includes("prompt") || k.includes("input") || k.includes("context")) {
          result.inputTokens += value;
        }
        if (k.includes("completion") || k.includes("output") || k.includes("generated")) {
          result.outputTokens += value;
        }
        if (k.includes("total") && k.includes("token")) {
          result.totalTokens += value;
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  if (result.totalTokens <= 0) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

function collectUsageCost(payload) {
  const result = { costTotal: 0, currency: "" };
  const stack = [payload];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "number") {
        const k = key.toLowerCase();
        if (k.includes("cost") || k.includes("amount") || k.includes("usd")) {
          result.costTotal += value;
        }
      } else if (typeof value === "string") {
        const k = key.toLowerCase();
        if (!result.currency && k.includes("currency")) {
          result.currency = value;
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return result;
}

function trimBaseUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function fetchUsageByUrl(url, providerName, apiKeyValue) {
  if (!url) return null;
  const headers = buildUsageHeaders(providerName, apiKeyValue);
  return await httpGetJson(url, headers);
}

async function fetchModelUsage(config) {
  const window = buildUsageWindow();
  const providerName = (config.provider || "").toLowerCase();
  const apiKeyValue = config.apiKey || "";
  const base = trimBaseUrl(config.baseUrl || "");
  const modelName = config.model || "";
  const result = {
    provider: providerName,
    model: modelName,
    inputTokens: 0,
    outputTokens: 0,
    tokenTotal: 0,
    costTotal: 0,
    currency: "",
    updatedAt: Date.now(),
    window,
    usageUrl: "",
    costUrl: "",
    error: ""
  };
  if (!apiKeyValue) {
    result.error = "missing_api_key";
    return result;
  }
  let usageUrl = fillUsageUrl(config.usageUrl || "", window);
  if (!usageUrl) {
    if (providerName === "gpt" || providerName === "openai") {
      usageUrl = `${base}/v1/usage?start_date=${window.startDate}&end_date=${window.endDate}`;
    }
  }
  let costUrl = fillUsageUrl(config.costUrl || "", window);
  if (!costUrl && (providerName === "gpt" || providerName === "openai")) {
    costUrl = `${base}/v1/organization/costs?start_time=${window.startTime}&end_time=${window.endTime}`;
  }
  result.usageUrl = usageUrl;
  result.costUrl = costUrl;
  const usagePayload = await fetchUsageByUrl(usageUrl, providerName, apiKeyValue);
  const costPayload = await fetchUsageByUrl(costUrl, providerName, apiKeyValue);
  if (!usagePayload && !costPayload) {
    result.error = "usage_request_failed";
    return result;
  }
  const tokenInfo = collectUsageTokens(usagePayload);
  const costInfo = collectUsageCost(costPayload || usagePayload);
  result.inputTokens = tokenInfo.inputTokens;
  result.outputTokens = tokenInfo.outputTokens;
  result.tokenTotal = tokenInfo.totalTokens;
  result.costTotal = costInfo.costTotal;
  result.currency = costInfo.currency;
  if (!usagePayload) {
    result.error = "usage_unavailable";
  }
  return result;
}

async function updateModelUsage(type, config) {
  const snapshot = await fetchModelUsage(config);
  if (redisReady) {
    await redisClient.set(buildUsageKey(type), JSON.stringify(snapshot));
  }
  return snapshot;
}

async function getUsageSnapshot(type) {
  if (!redisReady) {
    const local = await getLocalUsageSnapshot(type);
    if (local) return { ...local, error: "local_only" };
    return null;
  }
  const raw = await redisClient.get(buildUsageKey(type));
  const snapshot = raw ? safeJson(raw) : null;
  if (!snapshot) {
    const local = await getLocalUsageSnapshot(type);
    if (local) {
      return { ...local, error: "local_only" };
    }
    return null;
  }
  if (snapshot.error === "usage_request_failed" || snapshot.error === "usage_unavailable") {
    const local = await getLocalUsageSnapshot(type);
    if (local) {
      return { ...local, error: "local_fallback" };
    }
  }
  return snapshot;
}

function scheduleUsageRefresh() {
  if (usageRefreshTimer) return;
  const run = async () => {
    await updateModelUsage("summary", {
      provider: summaryProvider,
      apiKey: summaryApiKey,
      model: summaryModel,
      baseUrl: summaryBaseUrl,
      usageUrl: summaryUsageUrl,
      costUrl: summaryCostUrl
    });
    await updateModelUsage("script", {
      provider: scriptProvider,
      apiKey: scriptApiKey,
      model: scriptModel,
      baseUrl: scriptBaseUrl,
      usageUrl: scriptUsageUrl,
      costUrl: scriptCostUrl
    });
  };
  usageRefreshTimer = setInterval(run, usageRefreshMs);
  setTimeout(run, 0);
}

/**
 * 读取请求体并限制最大长度
 */
function readBody(req, maxLen) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxLen) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(null));
  });
}

/**
 * 返回 JSON 响应
 */
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * 返回 HTML 响应
 */
function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  res.end(body);
}

/**
 * 读取并返回 HTML 文件
 */
async function sendHtmlFile(res, filePath) {
  if (!filePath) {
    return sendText(res, 404, "admin html not configured");
  }
  const html = await readTextIfExists(filePath);
  if (html == null) {
    return sendText(res, 404, "admin html not found");
  }
  return sendHtml(res, 200, html);
}

function contentTypeByExt(ext) {
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function sendAdminStaticFile(res, relPath) {
  if (!adminStaticDir) {
    return sendText(res, 404, "admin html not configured");
  }
  const normalizedRelPath = (relPath || "").replace(/^\/+/, "");
  const filePath = path.resolve(adminStaticDir, normalizedRelPath || "index.html");
  const relative = path.relative(adminStaticDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendText(res, 403, "Forbidden");
  }
  const content = await readTextIfExists(filePath);
  if (content == null) {
    return sendText(res, 404, "Not Found");
  }
  res.writeHead(200, {
    "Content-Type": contentTypeByExt(path.extname(filePath).toLowerCase()),
    "Cache-Control": "no-store"
  });
  res.end(content);
}

/**
 * 默认模型映射
 */
function defaultModel(p) {
  if (p === "deepseek") return "deepseek-chat";
  if (p === "qwen") return "qwen-plus";
  if (p === "glm") return "glm-4";
  if (p === "gemini") return "gemini-1.5-flash";
  return "gpt-4o-mini";
}

/**
 * 默认基础地址映射
 */
function defaultBaseUrl(p) {
  if (p === "deepseek") return "https://api.deepseek.com";
  if (p === "qwen") return "https://dashscope.aliyuncs.com/compatible-mode";
  if (p === "glm") return "https://open.bigmodel.cn/api/paas/v4";
  if (p === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com";
}

/**
 * OpenAI 兼容接口路径映射
 */
function openAiPath(p) {
  if (p === "glm") return "/chat/completions";
  return "/v1/chat/completions";
}

/**
 * 总结模型默认映射
 */
function defaultSummaryModel(p) {
  if (p === "deepseek") return "deepseek-chat";
  if (p === "qwen") return "qwen-plus";
  if (p === "glm") return "glm-4";
  if (p === "gemini") return "gemini-1.5-flash";
  return "gpt-4o-mini";
}

/**
 * 脚本模型默认映射
 */
function defaultScriptModel(p) {
  if (p === "deepseek") return "deepseek-chat";
  if (p === "qwen") return "qwen-max";
  if (p === "glm") return "glm-4";
  if (p === "gemini") return "gemini-1.5-pro";
  return "gpt-4o";
}
