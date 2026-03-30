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
// 请求体最大长度
const maxContentLength = Number(process.env.MAX_CONTENT_LENGTH || 200000);
// 任务缓存清理的最大存活时长
const taskTtlMs = Number(process.env.TASK_TTL_MS || 1800000);
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
// 同一学校触发脚本修复的最小提交数
const minQueueSize = Number(process.env.MIN_QUEUE_SIZE || 3);
// 同一学校合并窗口（毫秒）
const mergeWindowMs = Number(process.env.MERGE_WINDOW_MS || 10 * 60 * 1000);
// 脚本更新后 24 小时内的二次提交处理窗口
const reprocessWindowMs = Number(process.env.REPROCESS_WINDOW_MS || 24 * 60 * 60 * 1000);
const rateLimitPerMin = Number(process.env.RATE_LIMIT_PER_MIN || 120);
const rateLimitSchoolPerMin = Number(process.env.RATE_LIMIT_SCHOOL_PER_MIN || 60);
const summaryCostPerCall = Number(process.env.LLM_SUMMARY_COST_PER_CALL || 0);
const scriptCostPerCall = Number(process.env.LLM_SCRIPT_COST_PER_CALL || 0);
const parseCostPerCall = Number(process.env.LLM_PARSE_COST_PER_CALL || 0);
const scriptSignKey = process.env.SCRIPT_SIGN_KEY || "";
// 单次脚本修复并发控制
const schoolProcessing = new Map();

const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (error) => {
  console.error("redis error:", error);
});
await redisClient.connect();

// HTTP 服务：提供提交任务与查询任务状态
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  // 健康检查接口
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }
  // 提交解析任务
  if (req.method === "POST" && url.pathname === "/api/v1/parse_task") {
    // 读取请求体并限制长度
    const bodyText = await readBody(req, maxContentLength);
    if (bodyText == null) {
      return sendJson(res, 413, { code: 413, msg: "请求体过大" });
    }
    // 解析 JSON
    const body = safeJson(bodyText);
    const content = (body?.content || "").toString();
    const schoolId = (body?.schoolId || body?.school_id || "").toString();
    const scriptName = (body?.scriptName || body?.script_name || "").toString();
    // content 不能为空
    if (!content) {
      return sendJson(res, 400, { code: 400, msg: "缺少 content" });
    }
    // 未配置密钥时阻断请求
    if (!apiKey && provider !== "gemini") {
      return sendJson(res, 500, { code: 500, msg: "服务端未配置 API Key" });
    }
    if (!apiKey && provider === "gemini") {
      return sendJson(res, 500, { code: 500, msg: "服务端未配置 Gemini API Key" });
    }
    const clientIp = getClientIp(req);
    const rateAllowed = await checkRateLimit(clientIp, schoolId);
    if (!rateAllowed) {
      return sendJson(res, 429, { code: 429, msg: "请求过于频繁" });
    }
    const safeContent = sanitizeContent(content);
    // 生成任务并进入异步处理
    const taskId = crypto.randomUUID();
    await saveTask(taskId, { status: "PROCESSING", result: null, createdAt: Date.now() });
    runTask(taskId, safeContent).catch(async () => {
      await saveTask(taskId, { status: "FAILED", result: null, createdAt: Date.now() });
    });
    if (schoolId) {
      enqueueSchoolSubmission(schoolId, safeContent, scriptName);
    }
    return sendJson(res, 200, { code: 200, msg: "ok", taskId });
  }
  // 查询任务状态
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
        result: task.result
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
function enqueueSchoolSubmission(schoolId, content, scriptName) {
  const now = Date.now();
  const item = { content, scriptName, createdAt: now };
  const queueKey = buildQueueKey(schoolId);
  redisClient
    .rPush(queueKey, JSON.stringify(item))
    .then(() => redisClient.expire(queueKey, Math.ceil(reprocessWindowMs / 1000)))
    .catch((error) => console.error("enqueue error:", error));
  scheduleSchoolProcessing(schoolId);
}

/**
 * 调度学校维度的脚本修复流程
 */
function scheduleSchoolProcessing(schoolId) {
  if (schoolProcessing.get(schoolId)) return;
  schoolProcessing.set(schoolId, true);
  setTimeout(async () => {
    try {
      await processSchoolQueue(schoolId);
    } finally {
      schoolProcessing.set(schoolId, false);
    }
  }, 0);
}

/**
 * 学校维度队列处理逻辑
 */
async function processSchoolQueue(schoolId) {
  const lockKey = buildSchoolLockKey(schoolId);
  const lockToken = crypto.randomUUID();
  const lockAcquired = await acquireLock(lockKey, lockToken, mergeWindowMs);
  if (!lockAcquired) return;
  try {
    const queue = await getSchoolQueue(schoolId);
    if (queue.length < minQueueSize) return;
    const now = Date.now();
    const recentQueue = queue.filter((item) => now - item.createdAt <= mergeWindowMs);
    if (recentQueue.length < minQueueSize) return;
    const state = (await getSchoolState(schoolId)) || {
      lastSummaryHash: "",
      lastScriptHash: "",
      lastUpdatedAt: 0
    };
    const mergedText = recentQueue.map((item, index) => `【提交 ${index + 1}】\n${item.content}`).join("\n");
    const summary = await summarizeSubmissions(mergedText);
    if (!summary) return;
    const summaryHash = hashText(summary);
    const shouldProcessIndividually =
      state.lastUpdatedAt > 0 && now - state.lastUpdatedAt <= reprocessWindowMs && summaryHash !== state.lastSummaryHash;
    if (shouldProcessIndividually) {
      await processIndividualSummaries(schoolId, queue);
      await clearSchoolQueue(schoolId);
      return;
    }
    const scriptName = resolveScriptName(schoolId, recentQueue);
    const previousScript = await readScript(scriptName);
    const generatedScript = await generateParserScript(summary, previousScript);
    if (!generatedScript) return;
    const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript);
    if (!applyResult.ok) {
      await recordScriptFailure(scriptName, applyResult.reason || "脚本校验失败");
      return;
    }
    await setSchoolState(schoolId, {
      lastSummaryHash: summaryHash,
      lastScriptHash: hashText(generatedScript),
      lastUpdatedAt: now
    });
    await clearSchoolQueue(schoolId);
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

/**
 * 对每条提交逐条总结后再修复脚本
 */
async function processIndividualSummaries(schoolId, queue) {
  const summaries = [];
  for (const item of queue) {
    const summary = await summarizeSubmissions(item.content);
    if (summary) summaries.push(summary);
  }
  if (summaries.length === 0) return;
  const mergedSummary = summaries.map((text, index) => `【总结 ${index + 1}】\n${text}`).join("\n");
  const scriptName = resolveScriptName(schoolId, queue);
  const previousScript = await readScript(scriptName);
  const generatedScript = await generateParserScript(mergedSummary, previousScript);
  if (!generatedScript) return;
  const applyResult = await applyScriptUpdate(scriptName, generatedScript, previousScript);
  if (!applyResult.ok) {
    await recordScriptFailure(scriptName, applyResult.reason || "脚本校验失败");
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
async function runTask(taskId, content) {
  const startTime = Date.now();
  const resultText = await callProvider(content);
  const latencyMs = Date.now() - startTime;
  const existing = await getTask(taskId);
  const createdAt = existing?.createdAt || Date.now();
  if (!resultText) {
    await saveTask(taskId, { status: "FAILED", result: null, createdAt });
    await recordMetric("parse_failed", latencyMs, parseCostPerCall);
    return;
  }
  await saveTask(taskId, { status: "SUCCESS", result: resultText, createdAt });
  if (isEmptyResult(resultText)) {
    await recordMetric("parse_empty", latencyMs, parseCostPerCall);
  } else {
    await recordMetric("parse_success", latencyMs, parseCostPerCall);
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
async function summarizeSubmissions(content) {
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
    return "";
  }
  await recordMetric("summary_success", latencyMs, summaryCostPerCall);
  return rawText;
}

/**
 * 使用模型 2 生成或修复解析脚本
 */
async function generateParserScript(summary, previousScript) {
  const systemPrompt =
    "你是教务系统解析脚本工程师，输出必须是可直接运行的 JavaScript 解析脚本。" +
    "脚本运行环境为 QuickJS，无 DOM API，仅可使用字符串与正则。" +
    "禁止输出 Markdown 或多余说明。";
  const userPrompt =
    "请根据以下结构总结修复或生成解析脚本，要求输出完整 JS 脚本内容。" +
    "脚本必须返回 JSON 字符串，结构兼容 ParsedCourse 字段。" +
    "若提供旧脚本，请在其基础上修复，保留工具函数与已有规范。\n" +
    `【结构总结】\n${summary}\n` +
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
    return "";
  }
  await recordMetric("script_success", latencyMs, scriptCostPerCall);
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
 */
async function readScript(scriptName) {
  try {
    const fullPath = buildScriptPath(scriptName);
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return "";
  }
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

async function applyScriptUpdate(scriptName, content, previousContent) {
  const validation = validateScriptStructure(content);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }
  const fullPath = buildScriptPath(scriptName);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (previousContent) {
      await writeBackupScript(scriptName, previousContent);
    }
    await fs.writeFile(fullPath, content, "utf-8");
    const meta = await buildScriptMeta(scriptName, content);
    await writeScriptMeta(scriptName, meta);
    return { ok: true };
  } catch (error) {
    if (previousContent) {
      try {
        await fs.writeFile(fullPath, previousContent, "utf-8");
      } catch {
        return { ok: false, reason: "脚本写入失败且回滚失败" };
      }
    }
    return { ok: false, reason: error?.message || "脚本写入失败" };
  }
}

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
  return { ok: true };
}

async function buildScriptMeta(scriptName, content) {
  const previousMeta = await getScriptMeta(scriptName);
  const version = (previousMeta?.version || 0) + 1;
  const sha256 = hashText(content);
  const signature = signScript(content);
  return {
    scriptName,
    version,
    sha256,
    signature,
    updatedAt: Date.now()
  };
}

async function getScriptMeta(scriptName) {
  const metaKey = buildScriptMetaKey(scriptName);
  const cached = await redisClient.get(metaKey);
  if (cached) return safeJson(cached);
  try {
    const metaPath = buildScriptMetaPath(scriptName);
    const raw = await fs.readFile(metaPath, "utf-8");
    return safeJson(raw);
  } catch {
    return null;
  }
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
}

function signScript(content) {
  if (!scriptSignKey) return "";
  return crypto.createHmac("sha256", scriptSignKey).update(content).digest("hex");
}

async function recordScriptFailure(scriptName, reason) {
  const payload = {
    scriptName: sanitizeScriptName(scriptName),
    reason,
    createdAt: Date.now()
  };
  await redisClient.lPush("script:failures", JSON.stringify(payload));
  await redisClient.lTrim("script:failures", 0, 200);
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

async function acquireLock(key, token, ttlMs) {
  const result = await redisClient.set(key, token, { NX: true, PX: ttlMs });
  return Boolean(result);
}

async function releaseLock(key, token) {
  const value = await redisClient.get(key);
  if (value === token) {
    await redisClient.del(key);
  }
}

function sanitizeContent(content) {
  let result = content || "";
  result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱]");
  result = result.replace(/1\d{10}/g, "[手机号]");
  result = result.replace(/\b\d{17}[\dXx]\b/g, "[身份证]");
  result = result.replace(/\b\d{9,12}\b/g, "[学号]");
  result = result.replace(/(姓名|name)[:：]\s*[^\s<]{2,10}/gi, "$1:[姓名]");
  return result;
}

function buildScriptPath(scriptName) {
  const safeName = sanitizeScriptName(scriptName);
  return path.join(scriptOutputDir, safeName);
}

function buildScriptMetaPath(scriptName) {
  const safeName = sanitizeScriptName(scriptName).replace(/\.js$/i, "");
  return path.join(scriptOutputDir, `${safeName}.meta.json`);
}

function sanitizeScriptName(scriptName) {
  const name = (scriptName || "").replace(/[\\/]/g, "_").trim();
  if (name.toLowerCase().endsWith(".js")) return name;
  return `${name || "unknown"}.js`;
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

function buildMetricKey(type) {
  return `metrics:${type}`;
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
