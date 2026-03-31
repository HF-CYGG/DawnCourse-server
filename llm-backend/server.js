import http from "node:http";
import { URL } from "node:url";
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
// 低成本总结模型配置（模型 1）
const summaryProvider = (process.env.LLM_SUMMARY_PROVIDER || "gpt").toLowerCase();
const summaryApiKey = process.env.LLM_SUMMARY_API_KEY || "";
const summaryModel = process.env.LLM_SUMMARY_MODEL || defaultSummaryModel(summaryProvider);
const summaryBaseUrl = process.env.LLM_SUMMARY_BASE_URL || defaultBaseUrl(summaryProvider);
// 高成本脚本修复模型配置（模型 2）
const scriptProvider = (process.env.LLM_SCRIPT_PROVIDER || "gpt").toLowerCase();
const scriptApiKey = process.env.LLM_SCRIPT_API_KEY || "";
const scriptModel = process.env.LLM_SCRIPT_MODEL || defaultScriptModel(scriptProvider);
const scriptBaseUrl = process.env.LLM_SCRIPT_BASE_URL || defaultBaseUrl(scriptProvider);
const provider = summaryProvider;
const apiKey = summaryApiKey;
const model = summaryModel;
const baseUrl = summaryBaseUrl;
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
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
const summaryCostPerCall = Number(process.env.LLM_SUMMARY_COST_PER_CALL || 0);
const scriptCostPerCall = Number(process.env.LLM_SCRIPT_COST_PER_CALL || 0);
const parseCostPerCall = Number(process.env.LLM_PARSE_COST_PER_CALL || 0);
const scriptSignKey = process.env.SCRIPT_SIGN_KEY || "";
const scriptSignPrivateKey = process.env.SCRIPT_SIGN_PRIVATE_KEY || "";
const schoolMetricsFile =
  process.env.SCHOOL_METRICS_FILE || path.join(scriptOutputDir, "metrics", "school_metrics.txt");
const metricsFlushMs = Number(process.env.METRICS_FLUSH_MS || 5000);
const offlineReplayDatasetJson = process.env.OFFLINE_REPLAY_DATASET_JSON || "";
const offlineReplayRequired = process.env.OFFLINE_REPLAY_REQUIRED === "true";
const canaryPercent = Number(process.env.CANARY_PERCENT || 0);
const canarySchoolsRaw = process.env.CANARY_SCHOOLS || "";
const rollbackFailureWindowMs = Number(process.env.ROLLBACK_FAILURE_WINDOW_MS || 30 * 60 * 1000);
const rollbackFailureThreshold = Number(process.env.ROLLBACK_FAILURE_THRESHOLD || 3);
const backupTtlMs = Number(process.env.BACKUP_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const backpressurePendingThreshold = Number(process.env.BACKPRESSURE_PENDING_THRESHOLD || 20);
const backpressureMergeWindowMs = Number(
  process.env.BACKPRESSURE_MERGE_WINDOW_MS || Math.max(mergeWindowMs, 20 * 60 * 1000)
);
const degradeHighCostEnabled = process.env.DEGRADE_HIGH_COST === "true";
const issueClusterSimilarity = Number(process.env.ISSUE_CLUSTER_SIMILARITY || 0.45);
// 管理后台会话有效期（默认 12 小时）
const adminSessionTtlMs = Number(process.env.ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
// 管理后台静态页面本地调试根目录（为空则不启用静态页面服务）
const adminWebRoot = (process.env.ADMIN_WEB_ROOT || "").trim();
const adminIndexPath = adminWebRoot
  ? path.resolve(adminWebRoot, "admin", "index.html")
  : "";
const adminLocalMode = process.env.ADMIN_LOCAL_MODE === "true";
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
let adminLocalCredentials = null;
const adminLocalSessions = new Map();
const canarySchoolSet = parseCommaSet(canarySchoolsRaw);
const offlineReplayDataset = parseOfflineReplayDataset(offlineReplayDatasetJson);

// ---------------------------------------------------------------------------
// 初始化与全局变量
// ---------------------------------------------------------------------------
const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (error) => {
  console.error("redis error:", error);
});
if (!adminLocalMode) {
  await redisClient.connect();
}
// 初始化管理后台账号密码，仅首次启动生成一次
const adminCredentialInfo = await initAdminCredentials();
if (adminCredentialInfo) {
  console.log(
    `admin credentials: username=${adminCredentialInfo.username} password=${adminCredentialInfo.password}`
  );
}
await ensureStorageLayout();

// ---------------------------------------------------------------------------
// HTTP 服务入口
// 提供客户端任务提交、状态轮询，以及管理后台的各种 API
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  // 健康检查接口
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }
  // ---------------------------------------------------------------------------
  // [本地调试] 管理后台静态页面（仅当配置 ADMIN_WEB_ROOT 时启用）
  // ---------------------------------------------------------------------------
  if (
    adminWebRoot &&
    req.method === "GET" &&
    (url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin/index.html")
  ) {
    return sendHtmlFile(res, adminIndexPath);
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
  // ---------------------------------------------------------------------------
  // [管理后台接口] 晋升灰度脚本 (Pending -> Active/Canary)
  // 用于管理员手动干预：将因灰度策略或验证拦截而处于 pending 状态的脚本发布
  // ---------------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/v1/admin/promote_script") {
    const auth = await requireAdminAuth(req);
    if (!auth.ok) {
      return sendJson(res, 401, { code: 401, msg: "未登录" });
    }
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    const body = safeJson(bodyText);
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const releaseStage = (body?.releaseStage || body?.release_stage || "active").toString();
    if (!scriptName) {
      return sendJson(res, 400, { code: 400, msg: "缺少 scriptName" });
    }
    const pending = await loadPendingScript(scriptName);
    if (!pending) {
      return sendJson(res, 404, { code: 404, msg: "未找到待发布脚本" });
    }
    const previousContent = await readScript(scriptName);
    const previousMeta = await getScriptMeta(scriptName);
    const result = await applyScriptUpdate(scriptName, pending, previousContent, {
      previousMeta,
      forceRelease: true,
      releaseStage,
      appliedBy: auth.username
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
      appliedBy: auth.username
    });
    if (!result.ok) {
      return sendJson(res, 500, { code: 500, msg: result.reason || "回滚失败" });
    }
    const meta = await getScriptMeta(scriptName);
    return sendJson(res, 200, { code: 200, data: { meta } });
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
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    const clientVersion = (body?.clientVersion || body?.client_version || "").toString();
    const userConsent = body?.userConsent === true || body?.consent === true;
    // content 不能为空
    if (!content) {
      return sendJson(res, 400, { code: 400, msg: "缺少 content" });
    }
    // 必须有用户明确同意，避免静默上传
    if (!userConsent) {
      return sendJson(res, 400, { code: 400, msg: "需要用户明确同意后才能上传" });
    }
    // 未配置密钥时阻断请求
    if (!apiKey && provider !== "gemini") {
      return sendJson(res, 500, { code: 500, msg: "服务端未配置 API Key" });
    }
    if (!apiKey && provider === "gemini") {
      return sendJson(res, 500, { code: 500, msg: "服务端未配置 Gemini API Key" });
    }
    const schoolId = await resolveSchoolIdByName(schoolIdInput, schoolNameInput);
    const schoolName = schoolNameInput || "";
    const clientIp = getClientIp(req);
    const rateAllowed = await checkRateLimit(clientIp, schoolId);
    if (!rateAllowed) {
      return sendJson(res, 429, { code: 429, msg: "请求过于频繁" });
    }
    const safeContent = sanitizeContent(content);
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
    const schoolSystemType = resolveSchoolSystemType(safeContent, schoolSystemTypeInput);
    if (schoolId) {
      await saveSchoolInfo(schoolId, schoolName, schoolSystemType);
    }
    // 生成任务并进入异步处理
    const taskId = crypto.randomUUID();
    await saveTask(taskId, {
      status: "PROCESSING",
      result: null,
      createdAt: Date.now(),
      schoolId,
      schoolName,
      schoolSystemType
    });
    runTask(taskId, safeContent, schoolId).catch(async () => {
      await saveTask(taskId, {
        status: "FAILED",
        result: null,
        createdAt: Date.now(),
        schoolId,
        schoolName,
        schoolSystemType
      });
    });
    if (schoolId) {
      await enqueueSchoolSubmission(schoolId, safeContent, scriptName, {
        schoolName,
        schoolSystemType
      });
    }
    await redisClient.set(idempotentKey, taskId, { PX: idempotentTtlMs });
    return sendJson(res, 200, {
      code: 200,
      msg: "ok",
      taskId,
      schoolId,
      schoolName,
      schoolSystemType
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
        schoolId: task.schoolId || "",
        schoolName: task.schoolName || "",
        schoolSystemType: task.schoolSystemType || "unknown"
      }
    });
  }
  return sendJson(res, 404, { code: 404, msg: "Not Found" });
});

// 启动服务
server.listen(port, () => {
  console.log(`llm-backend listening on ${port}`);
});

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
    schoolSystemType: schoolInfo?.schoolSystemType || "unknown"
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
  await setSchoolPhase(schoolId, "APPLYING");
  const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript, {
    schoolId,
    previousMeta
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
  const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript, {
    schoolId,
    previousMeta
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
  const resultText = await callProvider(content);
  const latencyMs = Date.now() - startTime;
  const existing = await getTask(taskId);
  const createdAt = existing?.createdAt || Date.now();
  const baseTask = {
    schoolId: existing?.schoolId || schoolId || "",
    schoolName: existing?.schoolName || "",
    schoolSystemType: existing?.schoolSystemType || "unknown"
  };
  if (!resultText) {
    await saveTask(taskId, { ...baseTask, status: "FAILED", result: null, createdAt });
    await recordMetric("parse_failed", latencyMs, parseCostPerCall);
    if (schoolId) {
      await recordSchoolMetric(schoolId, "parse_failed", latencyMs, parseCostPerCall);
    }
    return;
  }
  await saveTask(taskId, { ...baseTask, status: "SUCCESS", result: resultText, createdAt });
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
  // 统一系统提示词，要求严格输出 JSON
  const systemPrompt =
    "你是课程表解析助手，只输出严格 JSON 数组，不要包含任何解释、Markdown、代码块。" +
    "数组元素必须符合 ParsedCourse 结构：" +
    "name,teacher,location,dayOfWeek,startSection,duration,startWeek,endWeek,weekType。" +
    "所有字段必须齐全，整数必须是数字类型。";
  const userPrompt =
    "请从以下内容中提取课程信息，输出 JSON 数组，示例格式：" +
    "[{\"name\":\"高等数学\",\"teacher\":\"李四\",\"location\":\"A-301\",\"dayOfWeek\":1," +
    "\"startSection\":1,\"duration\":2,\"startWeek\":1,\"endWeek\":16,\"weekType\":0}]\n" +
    `课表内容如下：\n${content}\n只输出 JSON 数组。`;

  // Gemini 使用官方内容生成接口
  const rawText =
    provider === "gemini"
      ? await callGeminiRaw(systemPrompt, userPrompt)
      : await callOpenAICompatibleRaw(systemPrompt, userPrompt);
  return extractJsonArray(rawText || "");
}

/**
 * OpenAI 兼容接口调用（deepseek/qwen/glm/gpt）
 */
/**
 * OpenAI 兼容接口调用（返回原始文本）
 */
async function callOpenAICompatibleRaw(systemPrompt, userPrompt, options = {}) {
  const requestProvider = (options.provider || provider).toLowerCase();
  const requestApiKey = options.apiKey || apiKey;
  const requestModel = options.model || model;
  const requestBaseUrl = options.baseUrl || baseUrl;
  if (!requestApiKey) return null;
  const endpoint = `${requestBaseUrl}${openAiPath(requestProvider)}`;
  const body = {
    model: requestModel,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  const responseText = await httpPostJson(endpoint, body, {
    Authorization: `Bearer ${requestApiKey}`
  });
  if (!responseText) return null;
  const json = safeJson(responseText);
  const text = json?.choices?.[0]?.message?.content || "";
  return text;
}

/**
 * Gemini 官方接口调用（返回原始文本）
 */
async function callGeminiRaw(systemPrompt, userPrompt, options = {}) {
  const requestApiKey = options.apiKey || apiKey;
  const requestModel = options.model || model;
  const requestBaseUrl = options.baseUrl || baseUrl;
  if (!requestApiKey) return null;
  const endpoint = `${requestBaseUrl}/models/${requestModel}:generateContent?key=${requestApiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n${userPrompt}` }]
      }
    ],
    generationConfig: { temperature: 0 }
  };
  const responseText = await httpPostJson(endpoint, body, {});
  if (!responseText) return null;
  const json = safeJson(responseText);
  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ||
    json?.candidates?.[0]?.content?.text ||
    "";
  return text;
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
      ? await callGeminiRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        })
      : await callOpenAICompatibleRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText) {
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
  return rawText;
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
    content: (item?.content || "").toString().slice(0, 2000)
  }));
  const systemPrompt =
    "你是问题标准化助手，需要把原始反馈转换为结构化 JSON 数组。" +
    "每项包含 index, category, symptom, scope, trigger, confidence。" +
    "category 仅允许：login_failed,login_success,timetable_empty,server_error,parse_error,other。";
  const userPrompt =
    "请基于以下多条内容输出 JSON 数组，不要包含任何额外说明。\n" +
    `${JSON.stringify(payload)}`;
  const rawText =
    summaryProvider === "gemini"
      ? await callGeminiRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        })
      : await callOpenAICompatibleRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        });
  const parsed = rawText ? safeJson(rawText) : null;
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
      ? await callGeminiRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        })
      : await callOpenAICompatibleRaw(systemPrompt, userPrompt, {
          provider: summaryProvider,
          apiKey: summaryApiKey,
          model: summaryModel,
          baseUrl: summaryBaseUrl
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText) {
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
  return rawText;
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
      ? await callGeminiRaw(systemPrompt, userPrompt, {
          provider: scriptProvider,
          apiKey: scriptApiKey,
          model: scriptModel,
          baseUrl: scriptBaseUrl
        })
      : await callOpenAICompatibleRaw(systemPrompt, userPrompt, {
          provider: scriptProvider,
          apiKey: scriptApiKey,
          model: scriptModel,
          baseUrl: scriptBaseUrl
        });
  const latencyMs = Date.now() - startTime;
  if (!rawText) {
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
  return cleanScriptOutput(rawText);
}

/**
 * 解析脚本名
 */
function resolveScriptName(schoolId, queue) {
  const withName = queue.find((item) => item.scriptName);
  if (withName?.scriptName) return withName.scriptName;
  return `${schoolId}.js`;
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
 * 决定新修复脚本的发布阶段（全量/灰度/挂起）
 * - 如果明确指定或通过强制参数 (forceRelease)，直接全量发布
 * - 命中灰度名单或哈希桶 (canaryPercent)，进入 canary 阶段
 * - 否则进入 pending 阶段，等待人工确认或自动晋升
 */
function decideReleaseStage(schoolId, forceRelease, explicitStage) {
  if (explicitStage) return explicitStage;
  if (forceRelease) return "active";
  if (canaryPercent <= 0 && canarySchoolSet.size === 0) return "active";
  return shouldCanaryRelease(schoolId) ? "canary" : "pending";
}

function buildPendingScriptKey(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:pending:${safeName}`;
}

async function savePendingScript(scriptName, content) {
  await redisClient.set(buildPendingScriptKey(scriptName), content, { PX: backupTtlMs });
}

async function loadPendingScript(scriptName) {
  return await redisClient.get(buildPendingScriptKey(scriptName));
}

async function clearPendingScript(scriptName) {
  await redisClient.del(buildPendingScriptKey(scriptName));
}

function buildScriptBackupKey(scriptName, version) {
  const safeName = sanitizeScriptName(scriptName);
  return `script:backup:${safeName}:${version}`;
}

async function saveScriptBackup(scriptName, version, content) {
  if (!content) return;
  const key = buildScriptBackupKey(scriptName, version);
  await redisClient.set(key, content, { PX: backupTtlMs });
}

async function loadScriptBackup(scriptName, version) {
  if (!version) return "";
  const key = buildScriptBackupKey(scriptName, version);
  return (await redisClient.get(key)) || "";
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
    if (output == null) {
      return { ok: false, reason: "离线回放执行失败" };
    }
    const parsed = typeof output === "string" ? safeJson(output) : output;
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "离线回放输出非数组" };
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
        appliedBy: options.appliedBy
      });
      await writeScriptMeta(scriptName, meta);
    }
    return { ok: true, skipped: true };
  }
  const releaseStage = decideReleaseStage(options.schoolId || "", options.forceRelease, options.releaseStage);
  if (releaseStage === "pending") {
    await savePendingScript(scriptName, content);
    const meta = await buildScriptMeta(scriptName, content, {
      previousMeta: options.previousMeta,
      releaseStage,
      appliedBy: options.appliedBy
    });
    await writeScriptMeta(scriptName, meta);
    return { ok: true, pending: true, releaseStage };
  }
  const fullPath = buildScriptPath(scriptName);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (previousContent) {
      const previousVersion = options.previousMeta?.version || 0;
      await saveScriptBackup(scriptName, previousVersion, previousContent);
      await writeBackupScript(scriptName, previousContent);
    }
    await fs.writeFile(fullPath, content, "utf-8");
    const meta = await buildScriptMeta(scriptName, content, {
      previousMeta: options.previousMeta,
      releaseStage,
      appliedBy: options.appliedBy
    });
    await writeScriptMeta(scriptName, meta);
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
    updatedAt: Date.now()
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
  const cached = await redisClient.get(metaKey);
  if (cached) return safeJson(cached);
  const metaPath = buildScriptMetaPath(scriptName);
  const raw = await readTextIfExists(metaPath);
  if (raw) {
    await redisClient.set(metaKey, raw);
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
  await Promise.all([
    redisClient.set(metaKey, raw),
    fs.writeFile(metaPath, raw, "utf-8")
  ]);
}

async function writeBackupScript(scriptName, content) {
  const baseName = sanitizeScriptName(scriptName).replace(/\.js$/i, "");
  const backupName = `${baseName}.bak.${Date.now()}.js`;
  const fullPath = path.join(scriptOutputDir, backupName);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return fullPath;
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
    appliedBy: "auto-rollback"
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
  const failureKey = buildScriptFailureKey(scriptName);
  await redisClient.zAdd(failureKey, { score: now, value: `${now}:${payload.failureType}` });
  await redisClient.zRemRangeByScore(failureKey, 0, now - rollbackFailureWindowMs);
  if (options.autoRollbackEligible !== false) {
    await tryAutoRollback(scriptName);
  }
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
      failureCount: 0,
      latestMetricsAt: 0,
      schoolInfoById: {},
      failureTypeStats: {}
    };
  }
  const [metrics, schoolMetrics, failures, schoolIds, schoolInfoById] = await Promise.all([
    getMetricsSnapshot(),
    getSchoolMetricsSnapshot(),
    getScriptFailures(200),
    getKnownSchoolIds(),
    getSchoolInfoMap()
  ]);
  const schoolQueues = {};
  let totalQueueLength = 0;
  for (const schoolId of schoolIds) {
    const queueLength = await redisClient.lLen(buildQueueKey(schoolId));
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
    failureCount: failures.length,
    latestMetricsAt,
    schoolInfoById,
    failureTypeStats
  };
}

/**
 * 使用盐值对密码做不可逆哈希
 */
function hashPassword(password, salt) {
  return hashText(`${salt}:${password}`);
}

/**
 * 初始化管理后台账号密码，仅首次创建并写入 Redis
 */
async function initAdminCredentials() {
  if (adminLocalMode) {
    if (adminLocalCredentials) return null;
    const username = `admin_${randomString(6)}`;
    const password = randomString(12);
    const salt = randomString(8);
    const passwordHash = hashPassword(password, salt);
    adminLocalCredentials = { username, passwordHash, salt, createdAt: Date.now() };
    return { username, password };
  }
  const key = buildAdminCredentialKey();
  const cached = await redisClient.get(key);
  if (cached) return null;
  const username = `admin_${randomString(6)}`;
  const password = randomString(12);
  const salt = randomString(8);
  const passwordHash = hashPassword(password, salt);
  const payload = { username, passwordHash, salt, createdAt: Date.now() };
  await redisClient.set(key, JSON.stringify(payload));
  return { username, password };
}

/**
 * 获取当前保存的管理后台账号信息
 */
async function getAdminCredentials() {
  if (adminLocalMode) return adminLocalCredentials;
  const raw = await redisClient.get(buildAdminCredentialKey());
  return raw ? safeJson(raw) : null;
}

/**
 * 校验管理后台账号密码
 */
async function verifyAdminCredentials(username, password) {
  const credentials = await getAdminCredentials();
  if (!credentials) return false;
  if (credentials.username !== username) return false;
  const hash = hashPassword(password, credentials.salt || "");
  return hash === credentials.passwordHash;
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

async function getScriptFailures(limit) {
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

function resolveSchoolSystemType(content, input) {
  const normalized = normalizeSchoolSystemType(input);
  if (normalized) return normalized;
  return detectSchoolSystemType(content);
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
  if (!schoolId || !schoolName) return;
  const normalized = normalizeSchoolNameKey(schoolName);
  if (!normalized) return;
  await redisClient.hSet("school:alias", normalized, schoolId);
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
  // schoolId 缺失时使用学校名归一化结果
  const normalized = normalizeSchoolNameKey(schoolNameInput);
  if (!normalized) return "";
  // 先走精确别名命中
  const existing = await redisClient.hGet("school:alias", normalized);
  if (existing) return existing;
  // 再走模糊匹配命中，成功后写回别名
  const fuzzyMatched = await resolveSchoolIdByFuzzyName(normalized);
  if (fuzzyMatched) {
    await redisClient.hSet("school:alias", normalized, fuzzyMatched);
    return fuzzyMatched;
  }
  // 兜底：将归一化名称自身作为 schoolId
  await redisClient.hSet("school:alias", normalized, normalized);
  return normalized;
}

async function saveSchoolInfo(schoolId, schoolName, schoolSystemType) {
  // 维护学校基础信息，便于面板展示与统计
  if (!schoolId) return;
  const key = "school:info";
  const existingRaw = await redisClient.hGet(key, schoolId);
  const existing = existingRaw ? safeJson(existingRaw) : null;
  const resolvedSchoolName = resolveBestSchoolName(existing?.schoolName, schoolName);
  const payload = {
    schoolId,
    schoolName: resolvedSchoolName,
    schoolSystemType: schoolSystemType || existing?.schoolSystemType || "unknown",
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

/**
 * 管理后台会话 Redis Key
 */
function buildAdminSessionKey(token) {
  return `admin:session:${token}`;
}

function buildScriptMetaKey(scriptName) {
  return `script:meta:${sanitizeScriptName(scriptName)}`;
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
    if (Array.isArray(parsed)) return JSON.stringify(parsed);
  }
  const objectText = sliceJson(text, "{", "}");
  if (objectText) {
    const parsed = safeJson(objectText);
    if (parsed && Array.isArray(parsed.courses)) return JSON.stringify(parsed.courses);
  }
  return null;
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
