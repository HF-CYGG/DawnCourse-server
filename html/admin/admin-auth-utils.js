/**
 * 文件说明：Dawn Course 运维后台认证辅助工具。
 * 负责统一处理本地 token 清洗、接口业务错误识别与未授权状态判断，
 * 避免登录、会话校验、退出登录与页面初始化出现分叉逻辑。
 */

/**
 * 规范化本地缓存中的 token。
 * 会过滤空白、null、undefined 等脏值，避免前端初始化时把无效占位符当成真实登录态。
 *
 * @param {unknown} value 本地缓存中的原始 token
 * @returns {string} 规范化后的 token，无效时返回空字符串
 */
export function normalizeStoredAdminToken(value) {
  const token = `${value ?? ""}`.trim();
  if (!token) return "";
  const normalized = token.toLowerCase();
  if (normalized === "undefined" || normalized === "null") {
    return "";
  }
  return token;
}

/**
 * 解析管理后台接口的错误语义。
 * 兼容“HTTP 200 + 业务码 401/4xx”与标准 HTTP 错误两种返回方式。
 *
 * @param {number} statusCode HTTP 状态码
 * @param {Record<string, any> | null | undefined} payload 已解析的 JSON 响应体
 * @returns {{ kind: "unauthorized" | "error"; message: string } | null}
 */
export function resolveAdminApiError(statusCode, payload) {
  const businessCode = Number(payload?.code || 0);
  const message = `${payload?.msg || ""}`.trim();
  const unauthorized = statusCode === 401 || businessCode === 401;
  if (unauthorized) {
    return {
      kind: "unauthorized",
      message: message || "登录状态已失效，请重新登录"
    };
  }
  const hasHttpError = Number(statusCode || 0) >= 400;
  const hasBusinessError = businessCode > 0 && businessCode !== 200;
  if (hasHttpError || hasBusinessError) {
    return {
      kind: "error",
      message: message || `请求失败（${statusCode || businessCode || "unknown"}）`
    };
  }
  return null;
}
