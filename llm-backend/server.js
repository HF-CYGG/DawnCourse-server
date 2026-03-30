import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

// 服务端监听端口
const port = Number(process.env.PORT || 8080);
// 解析模型提供方：deepseek/qwen/glm/gemini/gpt
const provider = (process.env.LLM_PROVIDER || "gpt").toLowerCase();
// 解析模型 API Key
const apiKey = process.env.LLM_API_KEY || "";
// 解析模型名称
const model = process.env.LLM_MODEL || defaultModel(provider);
// 解析模型基础地址（可用于私有网关或代理）
const baseUrl = process.env.LLM_BASE_URL || defaultBaseUrl(provider);
// 单次请求超时
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 20000);
// 请求体最大长度
const maxContentLength = Number(process.env.MAX_CONTENT_LENGTH || 200000);
// 任务缓存清理的最大存活时长
const taskTtlMs = Number(process.env.TASK_TTL_MS || 1800000);
// 低成本总结模型配置（模型 1）
const summaryProvider = (process.env.LLM_SUMMARY_PROVIDER || provider).toLowerCase();
const summaryApiKey = process.env.LLM_SUMMARY_API_KEY || apiKey;
const summaryModel = process.env.LLM_SUMMARY_MODEL || defaultSummaryModel(summaryProvider);
const summaryBaseUrl = process.env.LLM_SUMMARY_BASE_URL || defaultBaseUrl(summaryProvider);
// 高成本脚本修复模型配置（模型 2）
const scriptProvider = (process.env.LLM_SCRIPT_PROVIDER || provider).toLowerCase();
const scriptApiKey = process.env.LLM_SCRIPT_API_KEY || apiKey;
const scriptModel = process.env.LLM_SCRIPT_MODEL || defaultScriptModel(scriptProvider);
const scriptBaseUrl = process.env.LLM_SCRIPT_BASE_URL || defaultBaseUrl(scriptProvider);
// 脚本输出目录
const scriptOutputDir = process.env.SCRIPT_OUTPUT_DIR || "/shared/parsers";
// 同一学校触发脚本修复的最小提交数
const minQueueSize = Number(process.env.MIN_QUEUE_SIZE || 3);
// 同一学校合并窗口（毫秒）
const mergeWindowMs = Number(process.env.MERGE_WINDOW_MS || 10 * 60 * 1000);
// 脚本更新后 24 小时内的二次提交处理窗口
const reprocessWindowMs = Number(process.env.REPROCESS_WINDOW_MS || 24 * 60 * 60 * 1000);
// 单次脚本修复并发控制
const schoolProcessing = new Map();

// 内存任务缓存（生产可替换为 Redis）
const tasks = new Map();
// 学校维度的提交队列
const schoolQueues = new Map();
// 学校维度的脚本状态
const schoolScriptState = new Map();
// 定时清理过期任务，避免内存增长
const cleanupInterval = Math.min(taskTtlMs, 600000);
setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of tasks.entries()) {
    if (now - task.createdAt > taskTtlMs) {
      tasks.delete(taskId);
    }
  }
}, cleanupInterval);

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
    // 生成任务并进入异步处理
    const taskId = crypto.randomUUID();
    tasks.set(taskId, { status: "PROCESSING", result: null, createdAt: Date.now() });
    runTask(taskId, content).catch(() => {
      const task = tasks.get(taskId);
      if (task) {
        tasks.set(taskId, { ...task, status: "FAILED", result: null });
      }
    });
    if (schoolId) {
      enqueueSchoolSubmission(schoolId, content, scriptName);
    }
    return sendJson(res, 200, { code: 200, msg: "ok", taskId });
  }
  // 查询任务状态
  if (req.method === "GET" && url.pathname === "/api/v1/task_status") {
    const taskId = url.searchParams.get("taskId") || "";
    if (!taskId) {
      return sendJson(res, 400, { code: 400, msg: "缺少 taskId" });
    }
    const task = tasks.get(taskId);
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
  const queue = schoolQueues.get(schoolId) || [];
  queue.push({ content, scriptName, createdAt: now });
  schoolQueues.set(schoolId, queue);
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
  const queue = schoolQueues.get(schoolId) || [];
  if (queue.length < minQueueSize) return;
  const now = Date.now();
  const recentQueue = queue.filter((item) => now - item.createdAt <= mergeWindowMs);
  if (recentQueue.length < minQueueSize) return;
  const state = schoolScriptState.get(schoolId) || {
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
    schoolQueues.set(schoolId, []);
    return;
  }
  const scriptName = resolveScriptName(schoolId, recentQueue);
  const previousScript = await readScript(scriptName);
  const generatedScript = await generateParserScript(summary, previousScript);
  if (!generatedScript) return;
  const scriptHash = hashText(generatedScript);
  await writeScript(scriptName, generatedScript);
  schoolScriptState.set(schoolId, {
    lastSummaryHash: summaryHash,
    lastScriptHash: scriptHash,
    lastUpdatedAt: now
  });
  schoolQueues.set(schoolId, []);
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
  await writeScript(scriptName, generatedScript);
  schoolScriptState.set(schoolId, {
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
  const resultText = await callProvider(content);
  if (!resultText) {
    const task = tasks.get(taskId);
    if (task) {
      tasks.set(taskId, { ...task, status: "FAILED", result: null });
    }
    return;
  }
  const task = tasks.get(taskId);
  if (task) {
    tasks.set(taskId, { ...task, status: "SUCCESS", result: resultText });
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
  if (summaryProvider === "gemini") {
    return await callGeminiRaw(systemPrompt, userPrompt, {
      provider: summaryProvider,
      apiKey: summaryApiKey,
      model: summaryModel,
      baseUrl: summaryBaseUrl
    });
  }
  return await callOpenAICompatibleRaw(systemPrompt, userPrompt, {
    provider: summaryProvider,
    apiKey: summaryApiKey,
    model: summaryModel,
    baseUrl: summaryBaseUrl
  });
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
  if (!rawText) return "";
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
    const fs = await import("node:fs/promises");
    const fullPath = `${scriptOutputDir}/${scriptName}`;
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * 写入脚本文件
 */
async function writeScript(scriptName, content) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const fullPath = `${scriptOutputDir}/${scriptName}`;
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
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
