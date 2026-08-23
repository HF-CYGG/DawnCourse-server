export function filterReleaseTracks(list, filters = {}) {
  const system = String(filters.system || "");
  const scope = String(filters.scope || "");
  const category = String(filters.category || "");
  const stage = String(filters.stage || "");
  const validation = String(filters.validation || "");
  return (Array.isArray(list) ? list : []).filter((item) => {
    if (system && String(item.schoolSystemType || "") !== system) return false;
    if (scope && String(item.scopeKind || "") !== scope) return false;
    if (category && String(item.category || "") !== category) return false;
    if (stage && String(item.releaseStage || "") !== stage) return false;
    if (validation && String(item.validationStatus || "") !== validation) return false;
    return true;
  });
}

export function validateUploadFileDescriptor(file) {
  const name = String(file?.name || "");
  const size = Number(file?.size || 0);
  if (!name.toLowerCase().endsWith(".js")) return { ok: false, error: "仅允许上传 .js 文件" };
  if (size <= 0) return { ok: false, error: "脚本文件为空" };
  if (size > 256 * 1024) return { ok: false, error: "文件不能超过 256 KiB" };
  return { ok: true, error: "" };
}

export function describeNonJsonAdminResponse(status, text, contentType = "") {
  const httpStatus = Number(status || 0);
  const body = String(text || "").trim();
  const type = String(contentType || "").toLowerCase();
  const looksLikeHtml = type.includes("text/html") || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);

  if (looksLikeHtml) {
    if (httpStatus === 501 || /unsupported\s+method/i.test(body)) {
      return "当前地址是静态预览服务，不支持登录。请通过 Dawn Course 后端服务的 /admin/ 地址访问。";
    }
    return `管理接口返回了网页而不是 JSON（HTTP ${httpStatus || "未知"}），请确认当前地址已连接 Dawn Course 后端服务。`;
  }

  return body || `管理接口返回了无法解析的响应（HTTP ${httpStatus || "未知"}）`;
}
