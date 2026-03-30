import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

// 服务端监听端口
const port = Number(process.env.PORT || 8080);
// 模型提供方：deepseek/qwen/glm/gemini/gpt
const provider = (process.env.LLM_PROVIDER || "gpt").toLowerCase();
// 模型 API Key
const apiKey = process.env.LLM_API_KEY || "";
// 模型名称
const model = process.env.LLM_MODEL || defaultModel(provider);
// 基础地址（可用于私有网关或代理）
const baseUrl = process.env.LLM_BASE_URL || defaultBaseUrl(provider);
// 单次请求超时
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 20000);
// 请求体最大长度
const maxContentLength = Number(process.env.MAX_CONTENT_LENGTH || 200000);
// 任务缓存清理的最大存活时长
const taskTtlMs = Number(process.env.TASK_TTL_MS || 1800000);

// 内存任务缓存（生产可替换为 Redis）
const tasks = new Map();
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
  // 统一系统提示词，要求只返回 JSON
  const systemPrompt =
    "你是课程表解析助手，只输出 JSON 数组，数组元素必须符合 ParsedCourse 结构：" +
    "name,teacher,location,dayOfWeek,startSection,duration,startWeek,endWeek,weekType。" +
    "只输出 JSON，不要任何解释或 Markdown。";
  const userPrompt = `课表内容如下：\n${content}\n请输出 JSON 数组`;

  // Gemini 使用官方内容生成接口
  if (provider === "gemini") {
    return await callGemini(systemPrompt, userPrompt);
  }
  return await callOpenAICompatible(systemPrompt, userPrompt);
}

/**
 * OpenAI 兼容接口调用（deepseek/qwen/glm/gpt）
 */
async function callOpenAICompatible(systemPrompt, userPrompt) {
  const endpoint = `${baseUrl}${openAiPath(provider)}`;
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  const responseText = await httpPostJson(endpoint, body, {
    Authorization: `Bearer ${apiKey}`
  });
  if (!responseText) return null;
  const json = safeJson(responseText);
  const text = json?.choices?.[0]?.message?.content || "";
  return extractJsonArray(text);
}

/**
 * Gemini 官方接口调用
 */
async function callGemini(systemPrompt, userPrompt) {
  const endpoint = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
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
  return extractJsonArray(text);
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
