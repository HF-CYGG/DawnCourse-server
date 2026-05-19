const overlay = document.getElementById("loginOverlay");
const loginBtn = document.getElementById("loginBtn");
const loginHint = document.getElementById("loginHint");
const loginUserInput = document.getElementById("loginUser");
const loginPassInput = document.getElementById("loginPass");
const toggleLoginPassBtn = document.getElementById("toggleLoginPass");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const exportBtn = document.getElementById("exportBtn");
const filterSchool = document.getElementById("filterSchool");
const filterSystemType = document.getElementById("filterSystemType");
const filterFailureType = document.getElementById("filterFailureType");
const failureSummary = document.getElementById("failureSummary");
const summaryCards = document.getElementById("summaryCards");
const pullScriptTableBody = document.querySelector("#pullScriptTable tbody");
const schoolTableBody = document.querySelector("#schoolTable tbody");
const failureTableBody = document.querySelector("#failureTable tbody");
const headerMeta = document.getElementById("headerMeta");
const scriptAnalyticsCards = document.getElementById("scriptAnalyticsCards");
const scriptAnalyticsMeta = document.getElementById("scriptAnalyticsMeta");
const scriptViewMode = document.getElementById("scriptViewMode");
const scriptFilterSystemType = document.getElementById("scriptFilterSystemType");
const scriptFilterFinalResult = document.getElementById("scriptFilterFinalResult");
const scriptFilterFailureType = document.getElementById("scriptFilterFailureType");
const scriptAnalyticsTableBody = document.querySelector("#scriptAnalyticsTable tbody");
const scriptSummaryCards = document.getElementById("scriptSummaryCards");
const scriptTableBody = document.querySelector("#scriptTable tbody");
const scriptModal = document.getElementById("scriptModal");
const scriptModalTitle = document.getElementById("scriptModalTitle");
const scriptModalMeta = document.getElementById("scriptModalMeta");
const scriptModalHistoryMeta = document.getElementById("scriptModalHistoryMeta");
const scriptModalHistory = document.getElementById("scriptModalHistory");
const scriptModalCode = document.getElementById("scriptModalCode");
const scriptModalClose = document.getElementById("scriptModalClose");
const scriptModalSource = document.getElementById("scriptModalSource");
const createUserBtn = document.getElementById("createUserBtn");
const newUserNameInput = document.getElementById("newUserName");
const newUserPasswordInput = document.getElementById("newUserPassword");
const userTableBody = document.querySelector("#userTable tbody");
const userStats = document.getElementById("userStats");
const runtimeLogSource = document.getElementById("runtimeLogSource");
const runtimeLogLimit = document.getElementById("runtimeLogLimit");
const runtimeLogRefreshBtn = document.getElementById("runtimeLogRefreshBtn");
const runtimeLogDownloadBtn = document.getElementById("runtimeLogDownloadBtn");
const runtimeLogAutoScroll = document.getElementById("runtimeLogAutoScroll");
const runtimeLogMeta = document.getElementById("runtimeLogMeta");
const runtimeLogContent = document.getElementById("runtimeLogContent");
let currentData = null;
let eventSource = null;
let scriptsCache = null;
const eventToastSeenMap = new Map();
let lastEventStreamWarnAt = 0;
let runtimeLogSnapshot = {
  source: "all",
  lines: [],
  loadedAt: 0
};
let scriptModalState = {
  scriptName: "",
  rollbackTargetVersion: 0,
  selectedVersion: 0,
  selectedHistoryKey: "",
  currentMeta: null
};

const navItems = document.querySelectorAll(".nav-item");
const pageSections = document.querySelectorAll(".page-section");
const pageTitle = document.getElementById("pageTitle");

function setLoginHint(text, type) {
  if (!loginHint) return;
  loginHint.textContent = text || "";
  loginHint.classList.remove("error", "success");
  if (type) loginHint.classList.add(type);
}

function setLoginLoading(loading) {
  if (!loginBtn) return;
  loginBtn.dataset.loading = loading ? "1" : "0";
  loginBtn.disabled = Boolean(loading);
}

async function performLogin() {
  setLoginHint("", "");
  const username = (loginUserInput?.value || "").trim();
  const password = (loginPassInput?.value || "").trim();
  if (!username || !password) {
    setLoginHint("请输入账号和密码", "error");
    return;
  }
  setLoginLoading(true);
  try {
    const res = await fetch("/api/v1/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      setLoginHint("账号或密码错误", "error");
      return;
    }
    const result = await res.json();
    setToken(result.data.token);
    overlay.style.display = "none";
    connectAdminEvents();
    await refreshData();
  } catch {
    setLoginHint("网络异常，请稍后重试", "error");
  } finally {
    setLoginLoading(false);
  }
}

function ensureToastContainer() {
  let container = document.querySelector(".toast-container");
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

function captureToastRects(container, ignoreElement) {
  const map = new Map();
  const children = Array.from(container.children);
  for (const el of children) {
    if (ignoreElement && el === ignoreElement) continue;
    map.set(el, el.getBoundingClientRect());
  }
  return map;
}

function animateToastReflow(container, beforeRects) {
  const children = Array.from(container.children);
  for (const el of children) {
    const first = beforeRects.get(el);
    if (!first) continue;
    const last = el.getBoundingClientRect();
    const dy = first.top - last.top;
    if (!dy) continue;
    el.style.setProperty("--ty", `${dy}px`);
  }
  container.getBoundingClientRect();
  for (const el of children) {
    if (!beforeRects.has(el)) continue;
    el.style.setProperty("--ty", "0px");
  }
}

function dismissToast(toast, container) {
  if (!toast || !toast.isConnected) return;
  if (toast.dataset.dismissing === "1") return;
  toast.dataset.dismissing = "1";
  toast.classList.add("leaving");
  const cleanup = () => {
    if (!toast.isConnected) return;
    const beforeRects = captureToastRects(container, toast);
    toast.remove();
    requestAnimationFrame(() => {
      animateToastReflow(container, beforeRects);
    });
  };
  const timer = setTimeout(cleanup, 400);
  toast.addEventListener(
    "transitionend",
    (e) => {
      if (e.target !== toast) return;
      clearTimeout(timer);
      cleanup();
    },
    { once: true }
  );
}

function defaultBaseUrl(providerRaw) {
  const p = (providerRaw || "").toString().trim().toLowerCase();
  if (p === "deepseek") return "https://api.deepseek.com";
  if (p === "qwen") return "https://dashscope.aliyuncs.com/compatible-mode";
  if (p === "glm") return "https://open.bigmodel.cn/api/paas/v4";
  if (p === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com";
}

function setupProviderBaseUrlAuto(providerId, baseUrlId) {
  const providerEl = document.getElementById(providerId);
  const baseUrlEl = document.getElementById(baseUrlId);
  if (!providerEl || !baseUrlEl) return;

  baseUrlEl.addEventListener("input", () => {
    baseUrlEl.dataset.autoManaged = "0";
  });

  providerEl.addEventListener("change", () => {
    const nextProvider = providerEl.value;
    const prevProvider = providerEl.dataset.prevValue || nextProvider;
    const prevDefault = defaultBaseUrl(prevProvider);
    const nextDefault = defaultBaseUrl(nextProvider);
    const current = (baseUrlEl.value || "").toString().trim();
    const lastDefault = (baseUrlEl.dataset.lastDefault || "").toString().trim();

    const shouldAutoUpdate =
      baseUrlEl.dataset.autoManaged === "1" ||
      current === "" ||
      current === prevDefault ||
      (lastDefault && current === lastDefault);

    if (shouldAutoUpdate) {
      baseUrlEl.value = nextDefault;
      baseUrlEl.dataset.autoManaged = "1";
      baseUrlEl.dataset.lastDefault = nextDefault;
    }

    providerEl.dataset.prevValue = nextProvider;
  });
}

function showToast(level, title, message) {
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${level || ""}`.trim();
  const safeTitle = (title || "提示").toString();
  const safeMessage = (message || "").toString();
  toast.innerHTML = `
    <div class="toast-title">
      <span>${safeTitle}</span>
      <button class="toast-close" type="button">关闭</button>
    </div>
    <div class="toast-message">${safeMessage}</div>
  `;
  const closeBtn = toast.querySelector(".toast-close");
  closeBtn.addEventListener("click", () => {
    dismissToast(toast, container);
  });
  const beforeRects = captureToastRects(container);
  container.prepend(toast);
  animateToastReflow(container, beforeRects);
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
  setTimeout(() => {
    dismissToast(toast, container);
  }, level === "error" ? 15000 : 8000);
}

function closeAdminEvents() {
  if (!eventSource) return;
  try {
    eventSource.close();
  } catch {}
  eventSource = null;
}

function shouldToastEventLog(entry) {
  const level = (entry?.level || "").toString();
  if (level !== "error" && level !== "warning") return false;
  const source = (entry?.detail?.source || "").toString();
  if (source === "admin-api") return false;
  const message = (entry?.message || "").toString();
  const key = `${entry?.time || ""}|${level}|${source}|${message}`;
  const now = Date.now();
  const expireAt = eventToastSeenMap.get(key) || 0;
  if (expireAt > now) return false;
  eventToastSeenMap.set(key, now + 5 * 60 * 1000);
  if (eventToastSeenMap.size > 200) {
    for (const [k, v] of eventToastSeenMap.entries()) {
      if (v <= now) eventToastSeenMap.delete(k);
    }
  }
  return true;
}

function connectAdminEvents() {
  const token = getToken();
  if (!token) return;
  closeAdminEvents();
  eventSource = new EventSource(`/api/v1/admin/events?token=${encodeURIComponent(token)}`);
  eventSource.addEventListener("log", (event) => {
    try {
      const entry = JSON.parse(event.data || "{}");
      const level = (entry.level || "").toString();
      const message = (entry.message || "").toString();
      if (!shouldToastEventLog(entry)) return;
      if (level === "error") {
        showToast("error", "服务端错误", message);
      } else if (level === "warning") {
        showToast("warning", "服务端告警", message);
      }
    } catch (e) {
      console.error("Failed to parse event log", e);
    }
  });
  eventSource.addEventListener("hello", () => {});
  eventSource.addEventListener("ping", () => {});
  eventSource.onerror = () => {
    const now = Date.now();
    if (now - lastEventStreamWarnAt < 15000) return;
    lastEventStreamWarnAt = now;
    showToast("warning", "事件流断开", "将自动重连，若持续失败请检查服务端日志");
  };
}

async function reportClientError(payload) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch("/api/v1/admin/client_error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload || {})
    });
  } catch {}
}

window.addEventListener("error", (event) => {
  try {
    const message = (event?.message || "Unknown error").toString();
    const stack = (event?.error?.stack || "").toString();
    showToast("error", "前端错误", message);
    reportClientError({
      message,
      stack,
      url: location.href,
      userAgent: navigator.userAgent,
      extra: {
        filename: event?.filename || "",
        lineno: event?.lineno || 0,
        colno: event?.colno || 0
      }
    });
  } catch {}
});

window.addEventListener("unhandledrejection", (event) => {
  try {
    const reason = event?.reason;
    const message = reason instanceof Error ? reason.message : `${reason || "Unhandled rejection"}`;
    const stack = reason instanceof Error ? reason.stack : "";
    showToast("error", "前端未处理异常", message);
    reportClientError({
      message,
      stack,
      url: location.href,
      userAgent: navigator.userAgent,
      extra: { type: "unhandledrejection" }
    });
  } catch {}
});

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.getAttribute("data-target");
    navItems.forEach((nav) => nav.classList.remove("active"));
    item.classList.add("active");
    pageTitle.textContent = item.textContent.trim();

    pageSections.forEach((page) => {
      if (page.id === target) {
        page.classList.add("active");
        if (target === "page-config") loadConfig();
        if (target === "page-scripts") loadScriptsPage();
        if (target === "page-users") loadUsersPage();
        if (target === "page-runtime-logs") loadRuntimeLogs();
      } else {
        page.classList.remove("active");
      }
    });
  });
});

function getActivePageId() {
  const active = document.querySelector(".page-section.active");
  return active?.id || "";
}

function stageBadge(stage) {
  const value = (stage || "unknown").toString();
  if (value === "active") return `<span class="badge success">active</span>`;
  if (value === "canary") return `<span class="badge warning">gradual</span>`;
  if (value === "pending") return `<span class="badge danger">pending</span>`;
  if (value === "rollback") return `<span class="badge danger">rollback</span>`;
  return `<span class="badge">${value}</span>`;
}

function showScriptModal(scriptName, rollbackTargetVersion) {
  scriptModalState = {
    scriptName: (scriptName || "").toString(),
    rollbackTargetVersion: Number(rollbackTargetVersion || 0),
    selectedVersion: 0,
    selectedHistoryKey: "",
    currentMeta: null
  };
  scriptModalTitle.textContent = scriptModalState.scriptName || "脚本";
  scriptModalMeta.textContent = "";
  if (scriptModalHistoryMeta) scriptModalHistoryMeta.textContent = "";
  if (scriptModalHistory) scriptModalHistory.innerHTML = "";
  scriptModalCode.textContent = "加载中...";
  scriptModalSource.value = "current";
  scriptModal.style.display = "flex";
  loadScriptHistory();
  loadScriptModalContent();
}

function closeScriptModal() {
  scriptModal.style.display = "none";
  scriptModalCode.textContent = "";
  scriptModalMeta.textContent = "";
  if (scriptModalHistoryMeta) scriptModalHistoryMeta.textContent = "";
  if (scriptModalHistory) scriptModalHistory.innerHTML = "";
  scriptModalState = {
    scriptName: "",
    rollbackTargetVersion: 0,
    selectedVersion: 0,
    selectedHistoryKey: "",
    currentMeta: null
  };
}

async function loadScriptModalContent() {
  const scriptName = scriptModalState.scriptName;
  if (!scriptName) return;
  const source = scriptModalSource.value || "current";
  const version =
    source === "backup"
      ? Number(scriptModalState.selectedVersion || scriptModalState.rollbackTargetVersion || 0)
      : 0;
  const qs = new URLSearchParams();
  qs.set("scriptName", scriptName);
  qs.set("source", source);
  if (version) qs.set("version", String(version));
  try {
    const result = await fetchWithAuth(`/api/v1/admin/script_content?${qs.toString()}`);
    const payload = result.data || {};
    const meta = payload.meta || {};
    scriptModalState.currentMeta = meta || null;
    scriptModalMeta.textContent = `阶段 ${meta.releaseStage || "-"} | 版本 ${meta.version || 0} | 父版本 ${
      meta.parentVersion || 0
    } | 更新时间 ${formatTime(meta.updatedAt)} | 操作人 ${meta.appliedBy || "-"}`;
    scriptModalCode.textContent = payload.content || "";
  } catch (e) {
    scriptModalCode.textContent = e?.message === "unauthorized" ? "未登录" : "加载失败";
  }
}

function historyTypeLabel(type) {
  const t = (type || "").toString();
  if (t === "auto_repair" || t === "apply") return "写入";
  if (t === "pending") return "Pending";
  if (t === "promote_active") return "发布全量";
  if (t === "promote_canary") return "逐步推送";
  if (t === "rollback_admin") return "回滚(人工)";
  if (t === "rollback_auto") return "回滚(自动)";
  if (t === "failure") return "失败";
  if (t === "skipped") return "跳过";
  return t || "事件";
}

function renderScriptHistory(list) {
  if (!scriptModalHistory) return;
  const items = Array.isArray(list) ? list : [];
  if (scriptModalHistoryMeta) {
    scriptModalHistoryMeta.textContent = `最近 ${items.length} 条`;
  }
  scriptModalHistory.innerHTML = items
    .map((item) => {
      const meta = item?.meta || {};
      const ctx = item?.context || {};
      const failure = item?.failure || null;
      const titleLeft = `${historyTypeLabel(item?.type)} ${meta?.version ? `v${meta.version}` : ""}`.trim();
      const titleRight = formatTime(item?.createdAt || meta?.updatedAt || 0);
      const stage = meta?.releaseStage || item?.releaseStage || "";
      const categories = Array.isArray(ctx?.issueCategories) ? ctx.issueCategories.filter(Boolean) : [];
      const key = `${item?.type || ""}:${meta?.version || 0}:${item?.createdAt || 0}`;
      const isActive = scriptModalState.selectedHistoryKey && scriptModalState.selectedHistoryKey === key;
      const metaLines = [
        stage ? `阶段：${stage}` : "",
        meta?.parentVersion ? `父版本：v${meta.parentVersion}` : "",
        item?.appliedBy ? `操作人：${item.appliedBy}` : "",
        item?.schoolId ? `学校：${item.schoolId}` : "",
        ctx?.mode ? `模式：${ctx.mode}` : "",
        ctx?.clusterSize ? `聚类：${ctx.clusterSize}` : "",
        categories.length ? `分类：${categories.join(",")}` : "",
        ctx?.guidancePreview ? `指令：${ctx.guidancePreview}` : "",
        failure ? `失败：${failure.failureType || ""} ${failure.reason || ""}`.trim() : ""
      ].filter(Boolean);
      const badge = stage ? stageBadge(stage) : "";
      return `
        <div class="history-item ${isActive ? "active" : ""}" data-key="${encodeURIComponent(
          key
        )}" data-type="${encodeURIComponent(item?.type || "")}" data-version="${Number(meta?.version || 0)}" data-stage="${encodeURIComponent(
          stage
        )}">
          <div class="history-item-title">
            <div>${badge} ${titleLeft}</div>
            <div class="muted">${titleRight}</div>
          </div>
          <div class="history-item-meta">${metaLines.join("\n")}</div>
        </div>
      `;
    })
    .join("");
  if (!items.length) {
    scriptModalHistory.innerHTML = `<div class="muted">暂无历史事件</div>`;
  }
}

async function loadScriptHistory() {
  const scriptName = scriptModalState.scriptName;
  if (!scriptName) return;
  try {
    const qs = new URLSearchParams();
    qs.set("scriptName", scriptName);
    qs.set("limit", "200");
    const result = await fetchWithAuth(`/api/v1/admin/script_history?${qs.toString()}`);
    const list = result.data?.list || [];
    renderScriptHistory(list);
  } catch (e) {
    if (scriptModalHistory) {
      scriptModalHistory.innerHTML = `<div class="muted">历史加载失败</div>`;
    }
  }
}

if (scriptModalHistory) {
  scriptModalHistory.addEventListener("click", (e) => {
    const item = e.target?.closest?.(".history-item");
    if (!item) return;
    const type = decodeURIComponent(item.getAttribute("data-type") || "");
    const version = Number(item.getAttribute("data-version") || 0);
    const key = decodeURIComponent(item.getAttribute("data-key") || "");
    scriptModalState.selectedHistoryKey = key;
    if (type === "pending") {
      scriptModalSource.value = "pending";
      scriptModalState.selectedVersion = 0;
    } else {
      const currentVersion = Number(scriptModalState.currentMeta?.version || 0);
      if (version && currentVersion && version === currentVersion) {
        scriptModalSource.value = "current";
        scriptModalState.selectedVersion = 0;
      } else if (version) {
        scriptModalSource.value = "backup";
        scriptModalState.selectedVersion = version;
      } else {
        scriptModalSource.value = "current";
        scriptModalState.selectedVersion = 0;
      }
    }
    const nodes = scriptModalHistory.querySelectorAll(".history-item");
    nodes.forEach((node) => node.classList.remove("active"));
    item.classList.add("active");
    loadScriptModalContent();
  });
}

if (scriptModalClose) {
  scriptModalClose.addEventListener("click", closeScriptModal);
}
if (scriptModalSource) {
  scriptModalSource.addEventListener("change", loadScriptModalContent);
}
if (scriptModal) {
  scriptModal.addEventListener("click", (e) => {
    if (e.target === scriptModal) closeScriptModal();
  });
}

async function loadConfig() {
  try {
    const res = await fetch("/api/v1/admin/config", {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (res.status === 401) {
      clearToken();
      overlay.style.display = "flex";
      return;
    }
    const json = await res.json();
    if (json.code === 200) {
      const conf = json.data;
      document.getElementById("conf_summaryProviderRaw").value = conf.summaryProviderRaw || "auto";
      document.getElementById("conf_summaryModelRaw").value = conf.summaryModelRaw || "";
      document.getElementById("conf_summaryApiKey").value = conf.summaryApiKey || "";
      document.getElementById("conf_summaryBaseUrl").value = conf.summaryBaseUrl || "";
      document.getElementById("conf_summaryApiStyleRaw").value = conf.summaryApiStyleRaw || "";
      document.getElementById("conf_summaryRequestExtraJson").value =
        conf.summaryRequestExtraJson || "";

      document.getElementById("conf_scriptProviderRaw").value = conf.scriptProviderRaw || "auto";
      document.getElementById("conf_scriptModelRaw").value = conf.scriptModelRaw || "";
      document.getElementById("conf_scriptApiKey").value = conf.scriptApiKey || "";
      document.getElementById("conf_scriptBaseUrl").value = conf.scriptBaseUrl || "";
      document.getElementById("conf_scriptApiStyleRaw").value = conf.scriptApiStyleRaw || "";
      document.getElementById("conf_scriptRequestExtraJson").value =
        conf.scriptRequestExtraJson || "";

      document.getElementById("conf_modelAliasJson").value = conf.modelAliasJson || "";
      document.getElementById("conf_usageEnabled").checked = conf.usageEnabled;
      document.getElementById("conf_summaryUsageUrl").value = conf.summaryUsageUrl || "";
      document.getElementById("conf_summaryCostUrl").value = conf.summaryCostUrl || "";
      document.getElementById("conf_scriptUsageUrl").value = conf.scriptUsageUrl || "";
      document.getElementById("conf_scriptCostUrl").value = conf.scriptCostUrl || "";

      const summaryProviderEl = document.getElementById("conf_summaryProviderRaw");
      const summaryBaseUrlEl = document.getElementById("conf_summaryBaseUrl");
      if (summaryProviderEl && summaryBaseUrlEl) {
        const p = summaryProviderEl.value;
        const d = defaultBaseUrl(p);
        const current = (summaryBaseUrlEl.value || "").toString().trim();
        summaryProviderEl.dataset.prevValue = p;
        summaryBaseUrlEl.dataset.lastDefault = d;
        summaryBaseUrlEl.dataset.autoManaged = current === "" || current === d ? "1" : "0";
      }
      const scriptProviderEl = document.getElementById("conf_scriptProviderRaw");
      const scriptBaseUrlEl = document.getElementById("conf_scriptBaseUrl");
      if (scriptProviderEl && scriptBaseUrlEl) {
        const p = scriptProviderEl.value;
        const d = defaultBaseUrl(p);
        const current = (scriptBaseUrlEl.value || "").toString().trim();
        scriptProviderEl.dataset.prevValue = p;
        scriptBaseUrlEl.dataset.lastDefault = d;
        scriptBaseUrlEl.dataset.autoManaged = current === "" || current === d ? "1" : "0";
      }
    }
  } catch (e) {
    console.error("Failed to load config", e);
    showToast("error", "加载配置失败", e?.message || "网络错误");
  }
}

setupProviderBaseUrlAuto("conf_summaryProviderRaw", "conf_summaryBaseUrl");
setupProviderBaseUrlAuto("conf_scriptProviderRaw", "conf_scriptBaseUrl");

document.getElementById("saveConfigBtn").addEventListener("click", async () => {
  const conf = {
    summaryProviderRaw: document.getElementById("conf_summaryProviderRaw").value,
    summaryModelRaw: document.getElementById("conf_summaryModelRaw").value,
    summaryApiKey: document.getElementById("conf_summaryApiKey").value,
    summaryBaseUrl: document.getElementById("conf_summaryBaseUrl").value,
    summaryApiStyleRaw: document.getElementById("conf_summaryApiStyleRaw").value,
    summaryRequestExtraJson: document.getElementById("conf_summaryRequestExtraJson").value,

    scriptProviderRaw: document.getElementById("conf_scriptProviderRaw").value,
    scriptModelRaw: document.getElementById("conf_scriptModelRaw").value,
    scriptApiKey: document.getElementById("conf_scriptApiKey").value,
    scriptBaseUrl: document.getElementById("conf_scriptBaseUrl").value,
    scriptApiStyleRaw: document.getElementById("conf_scriptApiStyleRaw").value,
    scriptRequestExtraJson: document.getElementById("conf_scriptRequestExtraJson").value,

    modelAliasJson: document.getElementById("conf_modelAliasJson").value,
    usageEnabled: document.getElementById("conf_usageEnabled").checked,
    summaryUsageUrl: document.getElementById("conf_summaryUsageUrl").value,
    summaryCostUrl: document.getElementById("conf_summaryCostUrl").value,
    scriptUsageUrl: document.getElementById("conf_scriptUsageUrl").value,
    scriptCostUrl: document.getElementById("conf_scriptCostUrl").value
  };

  const btn = document.getElementById("saveConfigBtn");
  const originalText = btn.textContent;
  btn.textContent = "保存中...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/v1/admin/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify(conf)
    });
    const json = await res.json();
    if (json.code === 200) {
      showToast("info", "配置已保存", "保存成功");
    } else {
      showToast("error", "保存失败", json.msg || "保存失败");
    }
  } catch (e) {
    showToast("error", "网络错误", "无法连接到服务端");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

const systemTypeLabels = {
  zhengfang: "正方",
  qiangzhi: "强智",
  kingosoft: "青果",
  chaoxing: "超星",
  unknown: "未知"
};
const failureTypeLabels = {
  validation: "校验失败",
  replay: "离线回放失败",
  submission_replay: "提交回放失败",
  write: "写入失败",
  rollback: "回滚失败",
  parser_crash: "脚本崩溃",
  parser_empty: "脚本空结果",
  extractor_empty: "提取为空",
  unsupported_format: "内容格式不支持",
  login_required: "未进入课表页",
  captcha_required: "验证码页",
  non_timetable: "非课表页面",
  unknown: "未知"
};
const sourceTypeLabels = {
  client: "客户端",
  rule: "规则",
  model: "模型",
  url: "URL",
  content: "内容",
  unknown: "未知"
};

function getToken() {
  return localStorage.getItem("dawn_admin_token") || "";
}
function setToken(token) {
  localStorage.setItem("dawn_admin_token", token);
}
function clearToken() {
  localStorage.removeItem("dawn_admin_token");
}
function formatTime(ts) {
  if (!ts) return "-";
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
function formatCount(value) {
  return Number(value || 0).toLocaleString();
}
function formatCost(value) {
  return Number(value || 0).toFixed(4);
}
function formatTokens(value) {
  return Number(value || 0).toLocaleString();
}
function formatSystemType(value) {
  const key = value || "unknown";
  return systemTypeLabels[key] || key;
}
function formatFailureType(value) {
  const key = value || "unknown";
  return failureTypeLabels[key] || key;
}
function formatSourceType(value) {
  const key = value || "unknown";
  return sourceTypeLabels[key] || key;
}
function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}
function getSchoolInfo(data, schoolId) {
  return data.schoolInfoById?.[schoolId] || {};
}
function calcSuccessRate(success, failed, empty) {
  const total = success + failed + empty;
  if (total <= 0) return 0;
  return success / total;
}

/**
 * 汇总 App 端上报的脚本解析反馈
 *
 * 数据来源：/api/v1/admin/data.scriptParseFeedback
 * 结构：{ scriptName: [{ successCount, failureCount, ... }, ...] }
 */
function aggregateAppParseFeedback(scriptParseFeedback) {
  const summary = {
    successCount: 0,
    failureCount: 0,
    totalCount: 0
  };
  if (!scriptParseFeedback || typeof scriptParseFeedback !== "object") {
    return summary;
  }
  const scripts = Object.values(scriptParseFeedback);
  for (const versions of scripts) {
    if (!Array.isArray(versions)) continue;
    for (const item of versions) {
      const success = Number(item?.successCount || 0);
      const failure = Number(item?.failureCount || 0);
      summary.successCount += success;
      summary.failureCount += failure;
      summary.totalCount += success + failure;
    }
  }
  return summary;
}

function renderCards(data) {
  const metrics = data.metrics || {};
  const latestMetricsAt = data.latestMetricsAt || 0;
  const appParseSummary =
    data.scriptSessionFeedback?.totals?.totalCount > 0
      ? data.scriptSessionFeedback.totals
      : aggregateAppParseFeedback(data.scriptParseFeedback || {});
  const scriptPullStats = data.scriptPullStats || {};
  const pullTotal = Number(scriptPullStats.total || 0);
  const pullFromCloud = Number(scriptPullStats.fromCloud || 0);
  const pullFromLocal = Number(scriptPullStats.fromLocal || 0);
  const modelUsage = data.modelUsage || {};
  const summaryUsage = modelUsage.summary || {};
  const scriptUsage = modelUsage.script || {};
  const summarySub = summaryUsage.error
    ? `错误 ${summaryUsage.error}`
    : `费用 ${formatCost(summaryUsage.costTotal)}${summaryUsage.currency ? " " : ""}${
        summaryUsage.currency || ""
      } | 更新 ${formatTime(summaryUsage.updatedAt)}`;
  const scriptSub = scriptUsage.error
    ? `错误 ${scriptUsage.error}`
    : `费用 ${formatCost(scriptUsage.costTotal)}${scriptUsage.currency ? " " : ""}${
        scriptUsage.currency || ""
      } | 更新 ${formatTime(scriptUsage.updatedAt)}`;
  const cards = [
    {
      title: "App 上报解析成功",
      value: formatCount(appParseSummary.successCount),
      sub: `上报总数 ${formatCount(appParseSummary.totalCount)}`
    },
    {
      title: "App 上报解析失败",
      value: formatCount(appParseSummary.failureCount),
      sub: `成功率 ${appParseSummary.totalCount > 0 ? ((appParseSummary.successCount / appParseSummary.totalCount) * 100).toFixed(1) : "0.0"}%`
    },
    {
      title: "App 脚本拉取次数",
      value: formatCount(pullTotal),
      sub: `云端 ${formatCount(pullFromCloud)} | 本地 ${formatCount(pullFromLocal)}`
    },
    {
      title: "总结成功",
      value: formatCount(metrics.summary_success?.count),
      sub: `失败 ${formatCount(metrics.summary_failed?.count)}`
    },
    {
      title: "脚本修复成功",
      value: formatCount(metrics.script_success?.count),
      sub: `失败 ${formatCount(metrics.script_failed?.count)}`
    },
    {
      title: "学校数量",
      value: formatCount(data.schoolCount),
      sub: "出现过的学校"
    },
    {
      title: "队列总量",
      value: formatCount(data.totalQueueLength),
      sub: "待处理任务"
    },
    {
      title: "失败记录",
      value: formatCount(data.failureCount),
      sub: "最近 200 条内"
    },
    {
      title: "模型1 Token",
      value: formatTokens(summaryUsage.tokenTotal),
      sub: summarySub
    },
    {
      title: "模型2 Token",
      value: formatTokens(scriptUsage.tokenTotal),
      sub: scriptSub
    },
    {
      title: "模型费用",
      value: formatCost(
        (metrics.parse_success?.costTotal || 0) +
          (metrics.parse_failed?.costTotal || 0) +
          (metrics.parse_empty?.costTotal || 0) +
          (metrics.summary_success?.costTotal || 0) +
          (metrics.summary_failed?.costTotal || 0) +
          (metrics.script_success?.costTotal || 0) +
          (metrics.script_failed?.costTotal || 0)
      ),
      sub: `指标更新时间 ${formatTime(latestMetricsAt)}`
    }
  ];
  summaryCards.innerHTML = cards
    .map(
      (card) => `
          <div class="card">
            <h3>${card.title}</h3>
            <div class="value">${card.value}</div>
            <div class="sub">${card.sub}</div>
          </div>
        `
    )
    .join("");
}

function renderSchools(data, filters) {
  const entries = Object.entries(data.schoolMetrics || {});
  entries.sort((a, b) => (b[1].lastUpdatedAt || 0) - (a[1].lastUpdatedAt || 0));
  const filtered = entries.filter(([schoolId]) => {
    const info = getSchoolInfo(data, schoolId);
    if (filters.schoolId && schoolId !== filters.schoolId) return false;
    if (filters.systemType && (info.schoolSystemType || "unknown") !== filters.systemType) {
      return false;
    }
    return true;
  });
  schoolTableBody.innerHTML = filtered
    .map(([schoolId, info]) => {
      const queueLen = data.schoolQueues?.[schoolId] ?? 0;
      const rate = calcSuccessRate(info.parse_success, info.parse_failed, info.parse_empty);
      const badgeClass = rate >= 0.8 ? "success" : rate >= 0.5 ? "warning" : "danger";
      const schoolInfo = getSchoolInfo(data, schoolId);
      return `
            <tr>
              <td>${schoolId}</td>
              <td>${schoolInfo.schoolName || "-"}</td>
              <td>${formatSystemType(schoolInfo.schoolSystemType)}</td>
              <td>${formatSourceType(schoolInfo.systemSource)}</td>
              <td><span class="badge">${queueLen}</span></td>
              <td><span class="badge ${badgeClass}">${(rate * 100).toFixed(1)}%</span></td>
              <td>${info.parse_success}/${info.parse_failed}/${info.parse_empty}</td>
              <td>${info.summary_success}/${info.summary_failed}</td>
              <td>${info.script_success}/${info.script_failed}</td>
              <td>${formatCost(info.costTotal)}</td>
              <td>${formatTime(info.lastUpdatedAt)}</td>
            </tr>
          `;
    })
    .join("");
  if (!filtered.length) {
    schoolTableBody.innerHTML = `<tr><td colspan="11" class="muted">暂无数据</td></tr>`;
  }
}

function renderFailures(data, filters) {
  const list = (data.failures || []).filter((item) => {
    const schoolId = item.schoolId || "";
    const schoolInfo = getSchoolInfo(data, schoolId);
    if (filters.schoolId && schoolId !== filters.schoolId) return false;
    if (filters.systemType && (schoolInfo.schoolSystemType || "unknown") !== filters.systemType) {
      return false;
    }
    if (filters.failureType && (item.failureType || "unknown") !== filters.failureType) {
      return false;
    }
    return true;
  });
  failureTableBody.innerHTML = list
    .map(
      (item) => `
          <tr>
            <td>${item.schoolId || "-"}</td>
            <td>${item.scriptName || "-"}</td>
            <td>${formatFailureType(item.failureType)}</td>
            <td>${item.reason || "-"}</td>
            <td>${formatTime(item.createdAt)}</td>
          </tr>
        `
    )
    .join("");
  if (!list.length) {
    failureTableBody.innerHTML = `<tr><td colspan="5" class="muted">暂无失败记录</td></tr>`;
  }
  renderFailureSummary(list);
  return list;
}

function renderPullScriptStats(data) {
  if (!pullScriptTableBody) return;
  const list = Array.isArray(data?.scriptPullStats?.scriptStats) ? data.scriptPullStats.scriptStats : [];
  pullScriptTableBody.innerHTML = list
    .map((item) => {
      const total = Number(item?.total || 0);
      const fromCloud = Number(item?.fromCloud || 0);
      const fromLocal = Number(item?.fromLocal || 0);
      const uniqueTotal = Number(item?.uniqueTotal || 0);
      const uniqueFromCloud = Number(item?.uniqueFromCloud || 0);
      const uniqueFromLocal = Number(item?.uniqueFromLocal || 0);
      const cloudRate = total > 0 ? ((fromCloud / total) * 100).toFixed(1) : "0.0";
      return `
        <tr>
          <td>${item?.scriptName || "-"}</td>
          <td>${item?.category || "-"}</td>
          <td>${formatCount(total)}</td>
          <td>${formatCount(fromCloud)}</td>
          <td>${formatCount(fromLocal)}</td>
          <td>${formatCount(uniqueTotal)}</td>
          <td>${formatCount(uniqueFromCloud)}</td>
          <td>${formatCount(uniqueFromLocal)}</td>
          <td>${cloudRate}%</td>
          <td>${formatTime(item?.updatedAt || 0)}</td>
        </tr>
      `;
    })
    .join("");
  if (!list.length) {
    pullScriptTableBody.innerHTML = `<tr><td colspan="10" class="muted">暂无脚本拉取统计</td></tr>`;
  }
}

function renderFailureSummary(failures) {
  const stats = {};
  failures.forEach((item) => {
    const type = item.failureType || "unknown";
    stats[type] = (stats[type] || 0) + 1;
  });
  const entries = Object.entries(stats);
  if (!entries.length) {
    failureSummary.innerHTML = `<span class="muted">暂无失败统计</span>`;
    return;
  }
  failureSummary.innerHTML = entries
    .map(([type, count]) => `<span class="badge">${formatFailureType(type)} ${formatCount(count)}</span>`)
    .join("");
}

async function fetchWithAuth(requestPath) {
  const token = getToken();
  const res = await fetch(requestPath, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (res.status === 401) {
    throw new Error("unauthorized");
  }
  return res.json();
}

async function postWithAuth(requestPath, payload) {
  const token = getToken();
  const res = await fetch(requestPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload || {})
  });
  if (res.status === 401) {
    throw new Error("unauthorized");
  }
  return res.json();
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function askOperationConfirm(title, detail, emphasizeText) {
  const headline = (title || "").trim();
  const message = (detail || "").trim();
  const emphasize = (emphasizeText || "").trim();
  const emphasizeMessage = emphasize ? `\n确认信息：${emphasize}` : "";
  return window.confirm(`${headline}\n${message}${emphasizeMessage}`.trim());
}

function renderUsersTable(list) {
  if (!userTableBody) return;
  const items = Array.isArray(list) ? list : [];
  if (userStats) {
    const onlineCount = items.filter((item) => Number(item?.lastLoginAt || 0) > 0).length;
    userStats.innerHTML = `
      <span class="badge">总账号 ${items.length}</span>
      <span class="badge success">有登录记录 ${onlineCount}</span>
      <span class="badge warning">首次可用默认账号 admin/admin</span>
    `;
  }
  if (!items.length) {
    userTableBody.innerHTML = `<tr><td colspan="7" class="muted">暂无用户</td></tr>`;
    return;
  }
  userTableBody.innerHTML = items
    .map((item) => {
      const username = (item?.username || "").toString();
      return `
      <tr>
        <td>${escapeHtml(username)}</td>
        <td>${formatTime(item?.createdAt || 0)}</td>
        <td>${formatTime(item?.updatedAt || 0)}</td>
        <td>${formatTime(item?.lastLoginAt || 0)}</td>
        <td>
          <div class="actions">
            <input class="user-input" type="text" data-role="rename-input" data-username="${encodeURIComponent(
              username
            )}" placeholder="新账号名">
            <button class="btn secondary" type="button" data-action="rename-user" data-username="${encodeURIComponent(
              username
            )}">修改账号</button>
          </div>
        </td>
        <td>
          <div class="actions">
            <input class="user-input" type="password" autocomplete="new-password" data-role="password-input" data-username="${encodeURIComponent(
              username
            )}" placeholder="新密码">
            <button class="btn secondary" type="button" data-action="reset-password" data-username="${encodeURIComponent(
              username
            )}">修改密码</button>
          </div>
        </td>
        <td>
          <button class="btn danger" type="button" data-action="delete-user" data-username="${encodeURIComponent(
            username
          )}">删除账号</button>
        </td>
      </tr>
      `;
    })
    .join("");
}

async function loadUsersPage() {
  try {
    const result = await fetchWithAuth("/api/v1/admin/users");
    renderUsersTable(result.data?.list || []);
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return;
    }
    showToast("error", "加载用户失败", e?.message || "网络错误");
  }
}

async function createUser() {
  const username = (newUserNameInput?.value || "").trim();
  const password = (newUserPasswordInput?.value || "").trim();
  if (!username || !password) {
    showToast("warning", "参数不足", "请输入账号和密码");
    return;
  }
  const confirmed = askOperationConfirm(
    "确认新增账号",
    `将创建账号：${username}`,
    "确认新增"
  );
  if (!confirmed) {
    showToast("warning", "已取消", "未执行新增操作");
    return;
  }
  const result = await postWithAuth("/api/v1/admin/users", { username, password });
  if (result.code !== 200) {
    showToast("error", "新增失败", result.msg || "未知错误");
    return;
  }
  if (newUserNameInput) newUserNameInput.value = "";
  if (newUserPasswordInput) newUserPasswordInput.value = "";
  showToast("info", "新增成功", `已创建账号 ${username}`);
  await loadUsersPage();
}

async function loadRuntimeLogs() {
  if (!runtimeLogContent) return;
  const source = (runtimeLogSource?.value || "all").toString();
  const limit = Math.max(100, Math.min(20000, Number(runtimeLogLimit?.value || 1000)));
  runtimeLogContent.textContent = "日志加载中...";
  try {
    const qs = new URLSearchParams();
    qs.set("source", source);
    qs.set("limit", String(limit));
    const result = await fetchWithAuth(`/api/v1/admin/runtime_logs?${qs.toString()}`);
    if (!result || Number(result.code) !== 200) {
      throw new Error(result?.msg || "日志接口不可用");
    }
    const files = result.data?.files || {};
    const lines = Array.isArray(result.data?.lines) ? result.data.lines : [];
    const counts = result.data?.sourceCounts || {};
    const missingSources = Array.isArray(result.data?.missingSources) ? result.data.missingSources : [];
    if (runtimeLogMeta) {
      const countText = `backend:${counts.backend ?? "-"} | nginx_access:${counts.nginx_access ?? "-"} | nginx_error:${
        counts.nginx_error ?? "-"
      } | admin:${counts.admin ?? "-"}`;
      const missingText = missingSources.length ? `\n缺失来源文件：${missingSources.join(", ")}` : "";
      runtimeLogMeta.textContent = `来源：${source} | 总行数：${lines.length}\n来源行数：${countText}\nbackend 文件：${
        files.backend || "-"
      } | nginx_access 文件：${files.nginx_access || "-"} | nginx_error 文件：${files.nginx_error || "-"}${missingText}`;
    }
    runtimeLogSnapshot = {
      source,
      lines,
      loadedAt: Date.now()
    };
    runtimeLogContent.textContent = lines.length ? lines.join("\n") : "暂无日志";
    if (runtimeLogAutoScroll?.checked) {
      runtimeLogContent.scrollTop = runtimeLogContent.scrollHeight;
    }
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return;
    }
    runtimeLogContent.textContent = "日志加载失败";
    showToast("error", "加载日志失败", e?.message || "网络错误");
  }
}

async function refreshData() {
  const result = await fetchWithAuth("/api/v1/admin/data");
  const data = result.data || {};
  currentData = data;
  headerMeta.textContent = `启动时间：${formatTime(data.serverStartedAt)} | 指标刷新：${formatTime(
    data.latestMetricsAt
  )} | 最后刷新：${formatTime(Date.now())} | 统计文件：${data.metricsFile || "-"}`;
  renderCards(data);
  updateFilterOptions(data);
  applyFilters();
}

function summarizeDistribution(stats, formatter = (value) => value, emptyText = "-") {
  const entries = Object.entries(stats || {}).filter(([, count]) => Number(count || 0) > 0);
  if (!entries.length) return emptyText;
  return entries
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 3)
    .map(([key, count]) => `${formatter(key)} ${formatCount(count)}`)
    .join(" | ");
}

function buildRawScriptAnalytics(scriptParseFeedback) {
  const byScript = {};
  for (const [scriptName, versions] of Object.entries(scriptParseFeedback || {})) {
    if (!Array.isArray(versions) || !versions.length) continue;
    let successCount = 0;
    let failureCount = 0;
    let updatedAt = 0;
    for (const item of versions) {
      successCount += Number(item?.successCount || 0);
      failureCount += Number(item?.failureCount || 0);
      updatedAt = Math.max(updatedAt, Number(item?.updatedAt || 0));
    }
    const totalCount = successCount + failureCount;
    byScript[scriptName] = {
      scriptName,
      successCount,
      failureCount,
      totalCount,
      successRate: totalCount > 0 ? Number((successCount / totalCount).toFixed(4)) : 0,
      bySystem: {},
      byFailureType: {},
      updatedAt,
      unknownRate: 0
    };
  }
  const scripts = Object.values(byScript).sort((a, b) => b.totalCount - a.totalCount || b.updatedAt - a.updatedAt);
  const totals = scripts.reduce(
    (acc, item) => {
      acc.successCount += Number(item.successCount || 0);
      acc.failureCount += Number(item.failureCount || 0);
      return acc;
    },
    { successCount: 0, failureCount: 0 }
  );
  totals.totalCount = totals.successCount + totals.failureCount;
  totals.successRate = totals.totalCount > 0 ? Number((totals.successCount / totals.totalCount).toFixed(4)) : 0;
  return {
    mode: "raw",
    totals,
    bySystem: {},
    byFailureType: {},
    scripts
  };
}

function buildSessionScriptAnalytics(scriptSessionFeedback) {
  const totals = scriptSessionFeedback?.totals || {
    successCount: 0,
    failureCount: 0,
    totalCount: 0,
    successRate: 0
  };
  const scripts = Object.values(scriptSessionFeedback?.byScript || {}).sort(
    (a, b) => Number(b.totalCount || 0) - Number(a.totalCount || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
  );
  return {
    mode: "session",
    totals,
    bySystem: scriptSessionFeedback?.bySystem || {},
    byFailureType: scriptSessionFeedback?.byFailureType || {},
    scripts
  };
}

function getCurrentScriptAnalytics(data) {
  const mode = scriptViewMode?.value === "raw" ? "raw" : "session";
  if (mode === "raw") {
    return buildRawScriptAnalytics(data?.scriptParseFeedback || {});
  }
  return buildSessionScriptAnalytics(data?.scriptSessionFeedback || {});
}

function updateScriptAnalyticsFilterOptions(analytics) {
  if (!scriptFilterSystemType || !scriptFilterFailureType) return;
  const currentSystem = scriptFilterSystemType.value;
  const currentFailure = scriptFilterFailureType.value;
  const systemEntries = analytics.mode === "session" ? Object.keys(analytics.bySystem || {}).sort() : [];
  const failureEntries = analytics.mode === "session" ? Object.keys(analytics.byFailureType || {}).sort() : [];
  scriptFilterSystemType.innerHTML = [`<option value="">全部</option>`]
    .concat(systemEntries.map((type) => `<option value="${type}">${formatSystemType(type)}</option>`))
    .join("");
  scriptFilterFailureType.innerHTML = [`<option value="">全部</option>`]
    .concat(failureEntries.map((type) => `<option value="${type}">${formatFailureType(type)}</option>`))
    .join("");
  if (systemEntries.includes(currentSystem)) {
    scriptFilterSystemType.value = currentSystem;
  }
  if (failureEntries.includes(currentFailure)) {
    scriptFilterFailureType.value = currentFailure;
  }
  const disabled = analytics.mode !== "session";
  scriptFilterSystemType.disabled = disabled;
  scriptFilterFailureType.disabled = disabled;
  if (disabled) {
    scriptFilterSystemType.value = "";
    scriptFilterFailureType.value = "";
  }
}

function renderScriptAnalyticsCards(analytics) {
  if (!scriptAnalyticsCards) return;
  const totals = analytics.totals || {};
  const topSystem = summarizeDistribution(analytics.bySystem, formatSystemType, analytics.mode === "session" ? "暂无" : "仅会话口径");
  const topFailure = summarizeDistribution(
    analytics.byFailureType,
    formatFailureType,
    analytics.mode === "session" ? "暂无" : "仅会话口径"
  );
  const cards = [
    {
      title: analytics.mode === "session" ? "会话成功" : "原始成功",
      value: formatCount(totals.successCount || 0),
      sub: `统计脚本 ${formatCount(analytics.scripts.length)}`
    },
    {
      title: analytics.mode === "session" ? "会话失败" : "原始失败",
      value: formatCount(totals.failureCount || 0),
      sub: `总数 ${formatCount(totals.totalCount || 0)}`
    },
    {
      title: "成功率",
      value: formatPercent(totals.successRate || 0),
      sub: analytics.mode === "session" ? "任一 parser 成功即计成功" : "逐 parser 原始上报"
    },
    {
      title: "系统分布",
      value: analytics.mode === "session" ? formatCount(Object.keys(analytics.bySystem || {}).length) : "-",
      sub: topSystem
    },
    {
      title: "失败类型",
      value: analytics.mode === "session" ? formatCount(Object.keys(analytics.byFailureType || {}).length) : "-",
      sub: topFailure
    }
  ];
  scriptAnalyticsCards.innerHTML = cards
    .map(
      (card) => `
          <div class="card">
            <h3>${card.title}</h3>
            <div class="value">${card.value}</div>
            <div class="sub">${card.sub}</div>
          </div>
        `
    )
    .join("");
}

function renderScriptAnalyticsTable(analytics) {
  if (!scriptAnalyticsTableBody) return;
  const mode = analytics.mode;
  const systemType = scriptFilterSystemType?.value || "";
  const finalResult = scriptFilterFinalResult?.value || "";
  const failureType = scriptFilterFailureType?.value || "";
  const list = (analytics.scripts || []).filter((item) => {
    if (finalResult === "success" && Number(item.successCount || 0) <= 0) return false;
    if (finalResult === "failed" && Number(item.failureCount || 0) <= 0) return false;
    if (mode === "session" && systemType && Number(item.bySystem?.[systemType] || 0) <= 0) return false;
    if (mode === "session" && failureType && Number(item.byFailureType?.[failureType] || 0) <= 0) return false;
    return true;
  });
  scriptAnalyticsTableBody.innerHTML = list
    .map((item) => {
      const systemSummary =
        mode === "session" ? summarizeDistribution(item.bySystem || {}, formatSystemType, "-") : "-";
      const failureSummary =
        mode === "session" ? summarizeDistribution(item.byFailureType || {}, formatFailureType, "-") : "-";
      const unknownRate = mode === "session" ? formatPercent(item.unknownRate || 0) : "-";
      return `
        <tr>
          <td>${item.scriptName || "-"}</td>
          <td>${formatCount(item.successCount || 0)}</td>
          <td>${formatCount(item.failureCount || 0)}</td>
          <td>${formatPercent(item.successRate || 0)}</td>
          <td>${systemSummary}</td>
          <td>${failureSummary}</td>
          <td>${unknownRate}</td>
          <td>${formatTime(item.updatedAt || 0)}</td>
        </tr>
      `;
    })
    .join("");
  if (!list.length) {
    scriptAnalyticsTableBody.innerHTML = `<tr><td colspan="8" class="muted">暂无脚本统计</td></tr>`;
  }
  if (scriptAnalyticsMeta) {
    scriptAnalyticsMeta.textContent =
      mode === "session"
        ? `当前为会话级口径：成功 ${formatCount(analytics.totals.successCount)}，失败 ${formatCount(
            analytics.totals.failureCount
          )}，任一 parser 成功则该次仅计成功。`
        : `当前为原始逐 parser 口径：成功 ${formatCount(analytics.totals.successCount)}，失败 ${formatCount(
            analytics.totals.failureCount
          )}，保留旧诊断统计。`;
  }
}

function renderScriptCards(list) {
  if (!scriptSummaryCards) return;
  const items = Array.isArray(list) ? list : [];
  const countByStage = { active: 0, canary: 0, pending: 0, rollback: 0, unknown: 0 };
  let pendingMissing = 0;
  let rollbackMissing = 0;
  for (const item of items) {
    const stage = (item?.meta?.releaseStage || "unknown").toString();
    countByStage[stage] = (countByStage[stage] || 0) + 1;
    if (stage === "pending" && !item?.pendingAvailable) pendingMissing += 1;
    if (item?.meta?.parentVersion && !item?.rollbackAvailable) rollbackMissing += 1;
  }
  const cards = [
    { title: "脚本总数", value: formatCount(items.length), sub: "scriptOutputDir 根目录" },
    { title: "Active", value: formatCount(countByStage.active), sub: "全量生效" },
    { title: "Gradual", value: formatCount(countByStage.canary), sub: "逐步推送" },
    { title: "Pending", value: formatCount(countByStage.pending), sub: `待发布（过期 ${formatCount(pendingMissing)}）` },
    { title: "回滚不可用", value: formatCount(rollbackMissing), sub: "父版本备份缺失/过期" }
  ];
  scriptSummaryCards.innerHTML = cards
    .map(
      (card) => `
          <div class="card">
            <h3>${card.title}</h3>
            <div class="value">${card.value}</div>
            <div class="sub">${card.sub}</div>
          </div>
        `
    )
    .join("");
}

function renderScriptsTable(list) {
  if (!scriptTableBody) return;
  const items = Array.isArray(list) ? list : [];
  scriptTableBody.innerHTML = items
    .map((item) => {
      const meta = item.meta || {};
      const stage = meta.releaseStage || "unknown";
      const v = Number(meta.version || 0);
      const pv = Number(meta.parentVersion || 0);
      const failCount = Number(item.recentFailureCount || 0);
      const failBadge =
        failCount > 0 ? `<span class="badge danger" style="margin-left:8px">失败 ${failCount}</span>` : "";
      const pendingBadge = item.pendingAvailable
        ? `<span class="badge warning">可发布</span>`
        : stage === "pending"
          ? `<span class="badge danger">已过期</span>`
          : `<span class="badge">无</span>`;
      const rollbackBadge =
        pv > 0
          ? item.rollbackAvailable
            ? `<span class="badge warning">可回滚</span>`
            : `<span class="badge danger">缺失</span>`
          : `<span class="badge">无</span>`;
      const promoteDisabled = item.pendingAvailable ? "" : "disabled";
      const rollbackDisabled = item.rollbackAvailable ? "" : "disabled";
      return `
        <tr>
          <td>${item.scriptName || "-"}${failBadge}</td>
          <td>${stageBadge(stage)}</td>
          <td>${v}</td>
          <td>${pv}</td>
          <td>${pendingBadge}</td>
          <td>${rollbackBadge}</td>
          <td>${formatTime(meta.updatedAt)}</td>
          <td>${meta.appliedBy || "-"}</td>
          <td>
            <div class="actions">
              <button class="btn secondary" type="button" data-action="view" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" data-pv="${pv}">查看</button>
              <button class="btn" type="button" data-action="promote-active" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${promoteDisabled}>发布全量</button>
              <button class="btn secondary" type="button" data-action="promote-gradual" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${promoteDisabled}>逐步推送</button>
              <button class="btn secondary" type="button" data-action="rollback" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${rollbackDisabled}>回滚上个版本</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
  if (!items.length) {
    scriptTableBody.innerHTML = `<tr><td colspan="9" class="muted">暂无脚本数据</td></tr>`;
  }
}

async function loadScriptsPage() {
  try {
    const [dataResult, scriptResult] = await Promise.all([
      fetchWithAuth("/api/v1/admin/data"),
      fetchWithAuth("/api/v1/admin/scripts")
    ]);
    const data = dataResult.data || {};
    currentData = data;
    headerMeta.textContent = `启动时间：${formatTime(data.serverStartedAt)} | 指标刷新：${formatTime(
      data.latestMetricsAt
    )} | 最后刷新：${formatTime(Date.now())} | 统计文件：${data.metricsFile || "-"}`;
    renderCards(data);
    updateFilterOptions(data);
    const analytics = getCurrentScriptAnalytics(data);
    updateScriptAnalyticsFilterOptions(analytics);
    renderScriptAnalyticsCards(analytics);
    renderScriptAnalyticsTable(analytics);
    const list = scriptResult.data?.list || [];
    scriptsCache = list;
    renderScriptCards(list);
    renderScriptsTable(list);
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return;
    }
    showToast("error", "加载脚本列表失败", e?.message || "网络错误");
  }
}

async function promoteWithDoubleConfirm(scriptName, pushMode) {
  const modeLabel = pushMode === "canary" ? "逐步推送" : "全量推送";
  const firstConfirm = window.confirm(`即将执行${modeLabel}：${scriptName}\n是否继续？`);
  if (!firstConfirm) return { aborted: true };
  const input = window.prompt(`请输入脚本名进行二次确认：${scriptName}`);
  if ((input || "").trim() !== scriptName) {
    showToast("warning", "已取消", "二次确认未通过");
    return { aborted: true };
  }
  const precheck = await postWithAuth("/api/v1/admin/promote_script", {
    scriptName,
    pushMode
  });
  if (precheck.code !== 409 || !precheck.data?.confirmToken) {
    return precheck;
  }
  return await postWithAuth("/api/v1/admin/promote_script", {
    scriptName,
    pushMode,
    confirmPublish: true,
    confirmToken: precheck.data.confirmToken
  });
}

if (scriptTableBody) {
  scriptTableBody.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const encoded = btn.getAttribute("data-script") || "";
    const scriptName = decodeURIComponent(encoded);
    const pv = Number(btn.getAttribute("data-pv") || 0);
    if (action === "view") {
      showScriptModal(scriptName, pv);
      return;
    }
    if (action === "promote-active" || action === "promote-gradual") {
      const pushMode = action === "promote-gradual" ? "canary" : "active";
      const modeLabel = pushMode === "canary" ? "逐步推送" : "全量推送";
      btn.disabled = true;
      try {
        const json = await promoteWithDoubleConfirm(scriptName, pushMode);
        if (json?.aborted) return;
        if (json.code === 200) {
          showToast("info", "发布成功", `${scriptName} -> ${modeLabel}`);
          await loadScriptsPage();
        } else {
          showToast("error", "发布失败", json.msg || "未知错误");
        }
      } catch (err) {
        showToast("error", "发布失败", err?.message || "网络错误");
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (action === "rollback") {
      btn.disabled = true;
      try {
        const json = await postWithAuth("/api/v1/admin/rollback_script", { scriptName });
        if (json.code === 200) {
          showToast("warning", "已回滚", `${scriptName} 已回滚到上个版本`);
          await loadScriptsPage();
        } else {
          showToast("error", "回滚失败", json.msg || "未知错误");
        }
      } catch (err) {
        showToast("error", "回滚失败", err?.message || "网络错误");
      } finally {
        btn.disabled = false;
      }
    }
  });
}

function updateFilterOptions(data) {
  const schoolIds = new Set([
    ...Object.keys(data.schoolMetrics || {}),
    ...Object.keys(data.schoolInfoById || {})
  ]);
  const schoolOptions = ["", ...Array.from(schoolIds).sort()];
  const currentSchool = filterSchool.value;
  filterSchool.innerHTML = schoolOptions
    .map((id) => {
      if (!id) return `<option value="">全部学校</option>`;
      const info = getSchoolInfo(data, id);
      const label = info.schoolName ? `${id}（${info.schoolName}）` : id;
      return `<option value="${id}">${label}</option>`;
    })
    .join("");
  if (currentSchool) filterSchool.value = currentSchool;

  const systemTypes = new Set(
    Object.values(data.schoolInfoById || {}).map((item) => item.schoolSystemType || "unknown")
  );
  const systemOptions = ["", ...Array.from(systemTypes).sort()];
  const currentSystem = filterSystemType.value;
  filterSystemType.innerHTML = systemOptions
    .map((type) => {
      if (!type) return `<option value="">全部类型</option>`;
      return `<option value="${type}">${formatSystemType(type)}</option>`;
    })
    .join("");
  if (currentSystem) filterSystemType.value = currentSystem;

  const failureTypes = new Set(Object.keys(data.failureTypeStats || {}));
  const failureOptions = ["", ...Array.from(failureTypes).sort()];
  const currentFailure = filterFailureType.value;
  filterFailureType.innerHTML = failureOptions
    .map((type) => {
      if (!type) return `<option value="">全部失败类型</option>`;
      return `<option value="${type}">${formatFailureType(type)}</option>`;
    })
    .join("");
  if (currentFailure) filterFailureType.value = currentFailure;
}

function applyFilters() {
  if (!currentData) return;
  const filters = {
    schoolId: filterSchool.value || "",
    systemType: filterSystemType.value || "",
    failureType: filterFailureType.value || ""
  };
  renderSchools(currentData, filters);
  renderFailures(currentData, filters);
  renderPullScriptStats(currentData);
}

function escapeCsv(value) {
  const text = `${value ?? ""}`;
  if (text.includes('"') || text.includes(",") || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvContent(data, filters) {
  const lines = [];
  lines.push("学校统计");
  lines.push(
    [
      "学校ID",
      "学校名称",
      "教务系统",
      "识别来源",
      "队列",
      "解析成功",
      "解析失败",
      "解析空",
      "总结成功",
      "总结失败",
      "脚本成功",
      "脚本失败",
      "费用",
      "最近更新"
    ].join(",")
  );
  Object.entries(data.schoolMetrics || {}).forEach(([schoolId, info]) => {
    const schoolInfo = getSchoolInfo(data, schoolId);
    if (filters.schoolId && schoolId !== filters.schoolId) return;
    if (filters.systemType && (schoolInfo.schoolSystemType || "unknown") !== filters.systemType) {
      return;
    }
    lines.push(
      [
        schoolId,
        schoolInfo.schoolName || "",
        formatSystemType(schoolInfo.schoolSystemType),
        formatSourceType(schoolInfo.systemSource),
        data.schoolQueues?.[schoolId] ?? 0,
        info.parse_success,
        info.parse_failed,
        info.parse_empty,
        info.summary_success,
        info.summary_failed,
        info.script_success,
        info.script_failed,
        formatCost(info.costTotal),
        formatTime(info.lastUpdatedAt)
      ]
        .map(escapeCsv)
        .join(",")
    );
  });
  lines.push("");
  lines.push("失败记录");
  lines.push(["学校ID", "脚本", "类型", "原因", "时间"].join(","));
  (data.failures || []).forEach((item) => {
    const schoolId = item.schoolId || "";
    const schoolInfo = getSchoolInfo(data, schoolId);
    if (filters.schoolId && schoolId !== filters.schoolId) return;
    if (filters.systemType && (schoolInfo.schoolSystemType || "unknown") !== filters.systemType) {
      return;
    }
    if (filters.failureType && (item.failureType || "unknown") !== filters.failureType) return;
    lines.push(
      [schoolId, item.scriptName || "", formatFailureType(item.failureType), item.reason || "", formatTime(item.createdAt)]
        .map(escapeCsv)
        .join(",")
    );
  });
  return `\ufeff${lines.join("\n")}`;
}

function exportCsv() {
  if (!currentData) return;
  const filters = {
    schoolId: filterSchool.value || "",
    systemType: filterSystemType.value || "",
    failureType: filterFailureType.value || ""
  };
  const csv = buildCsvContent(currentData, filters);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dawncourse_stats_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function checkSession() {
  try {
    await fetchWithAuth("/api/v1/admin/session");
    overlay.style.display = "none";
    connectAdminEvents();
    await refreshData();
  } catch {
    overlay.style.display = "flex";
    closeAdminEvents();
    requestAnimationFrame(() => {
      if (loginUserInput) loginUserInput.focus();
    });
  }
}

loginBtn.addEventListener("click", performLogin);
if (loginUserInput) {
  loginUserInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performLogin();
  });
}
if (loginPassInput) {
  loginPassInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performLogin();
  });
}
if (toggleLoginPassBtn && loginPassInput) {
  toggleLoginPassBtn.addEventListener("click", () => {
    const nextType = loginPassInput.type === "password" ? "text" : "password";
    loginPassInput.type = nextType;
    const showing = nextType === "text";
    toggleLoginPassBtn.textContent = showing ? "隐藏" : "显示";
    toggleLoginPassBtn.setAttribute("aria-label", showing ? "隐藏密码" : "显示密码");
    loginPassInput.focus();
  });
}

refreshBtn.addEventListener("click", async () => {
  const activePageId = getActivePageId();
  if (activePageId === "page-scripts") {
    await loadScriptsPage();
  } else if (activePageId === "page-users") {
    await loadUsersPage();
  } else if (activePageId === "page-runtime-logs") {
    await loadRuntimeLogs();
  } else {
    await refreshData();
  }
});
exportBtn.addEventListener("click", () => {
  exportCsv();
});
filterSchool.addEventListener("change", () => {
  applyFilters();
});
filterSystemType.addEventListener("change", () => {
  applyFilters();
});
filterFailureType.addEventListener("change", () => {
  applyFilters();
});
if (scriptViewMode) {
  scriptViewMode.addEventListener("change", () => {
    if (!currentData) return;
    const analytics = getCurrentScriptAnalytics(currentData);
    updateScriptAnalyticsFilterOptions(analytics);
    renderScriptAnalyticsCards(analytics);
    renderScriptAnalyticsTable(analytics);
  });
}
if (scriptFilterSystemType) {
  scriptFilterSystemType.addEventListener("change", () => {
    if (!currentData) return;
    renderScriptAnalyticsTable(getCurrentScriptAnalytics(currentData));
  });
}
if (scriptFilterFinalResult) {
  scriptFilterFinalResult.addEventListener("change", () => {
    if (!currentData) return;
    renderScriptAnalyticsTable(getCurrentScriptAnalytics(currentData));
  });
}
if (scriptFilterFailureType) {
  scriptFilterFailureType.addEventListener("change", () => {
    if (!currentData) return;
    renderScriptAnalyticsTable(getCurrentScriptAnalytics(currentData));
  });
}
if (createUserBtn) {
  createUserBtn.addEventListener("click", async () => {
    try {
      await createUser();
    } catch (e) {
      showToast("error", "新增失败", e?.message || "网络错误");
    }
  });
}
if (newUserPasswordInput) {
  newUserPasswordInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    try {
      await createUser();
    } catch (err) {
      showToast("error", "新增失败", err?.message || "网络错误");
    }
  });
}
if (userTableBody) {
  userTableBody.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const action = (btn.getAttribute("data-action") || "").toString();
    const username = decodeURIComponent(btn.getAttribute("data-username") || "");
    if (!username) return;
    try {
      if (action === "rename-user") {
        const input = userTableBody.querySelector(
          `input[data-role="rename-input"][data-username="${encodeURIComponent(username)}"]`
        );
        const newUsername = (input?.value || "").trim();
        if (!newUsername) {
          showToast("warning", "参数不足", "请输入新账号名");
          return;
        }
        const confirmed = askOperationConfirm(
          "确认修改账号名",
          `将账号 ${username} 修改为 ${newUsername}`,
          "确认改名"
        );
        if (!confirmed) {
          showToast("warning", "已取消", "未执行改名操作");
          return;
        }
        const result = await postWithAuth("/api/v1/admin/users/rename", { oldUsername: username, newUsername });
        if (result.code !== 200) {
          showToast("error", "修改失败", result.msg || "未知错误");
          return;
        }
        showToast("info", "修改成功", `${username} -> ${newUsername}`);
        await loadUsersPage();
        return;
      }
      if (action === "reset-password") {
        const input = userTableBody.querySelector(
          `input[data-role="password-input"][data-username="${encodeURIComponent(username)}"]`
        );
        const newPassword = (input?.value || "").trim();
        if (!newPassword) {
          showToast("warning", "参数不足", "请输入新密码");
          return;
        }
        const confirmed = askOperationConfirm(
          "确认重置密码",
          `将更新账号 ${username} 的登录密码`,
          "确认改密"
        );
        if (!confirmed) {
          showToast("warning", "已取消", "未执行改密操作");
          return;
        }
        const result = await postWithAuth("/api/v1/admin/users/password", { username, newPassword });
        if (result.code !== 200) {
          showToast("error", "修改失败", result.msg || "未知错误");
          return;
        }
        if (input) input.value = "";
        showToast("info", "修改成功", `账号 ${username} 密码已更新`);
        await loadUsersPage();
        return;
      }
      if (action === "delete-user") {
        const confirmed = askOperationConfirm(
          "确认删除账号",
          `将删除账号 ${username}，其登录会话会被立即失效`,
          "确认删除"
        );
        if (!confirmed) {
          showToast("warning", "已取消", "未执行删除操作");
          return;
        }
        const result = await postWithAuth("/api/v1/admin/users/delete", { username });
        if (result.code !== 200) {
          showToast("error", "删除失败", result.msg || "未知错误");
          return;
        }
        showToast("info", "删除成功", `账号 ${username} 已删除`);
        await loadUsersPage();
      }
    } catch (err) {
      if (err?.message === "unauthorized") {
        clearToken();
        overlay.style.display = "flex";
        closeAdminEvents();
        return;
      }
      showToast("error", "操作失败", err?.message || "网络错误");
    }
  });
}
if (runtimeLogRefreshBtn) {
  runtimeLogRefreshBtn.addEventListener("click", async () => {
    await loadRuntimeLogs();
  });
}
if (runtimeLogDownloadBtn) {
  runtimeLogDownloadBtn.addEventListener("click", async () => {
    if (!runtimeLogSnapshot.lines.length) {
      await loadRuntimeLogs();
    }
    const lines = runtimeLogSnapshot.lines;
    if (!lines.length) {
      showToast("warning", "暂无可下载日志", "请先刷新日志");
      return;
    }
    const source = runtimeLogSnapshot.source || "all";
    const timestamp = new Date(runtimeLogSnapshot.loadedAt || Date.now()).toISOString().replace(/[:.]/g, "-");
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `runtime-${source}-${timestamp}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("info", "下载开始", `已导出 ${lines.length} 行日志`);
  });
}
if (runtimeLogSource) {
  runtimeLogSource.addEventListener("change", async () => {
    await loadRuntimeLogs();
  });
}

logoutBtn.addEventListener("click", async () => {
  try {
    await fetchWithAuth("/api/v1/admin/logout");
  } catch {}
  clearToken();
  closeAdminEvents();
  overlay.style.display = "flex";
});

checkSession();

setInterval(async () => {
  if (overlay.style.display === "none") {
    try {
      const activePageId = getActivePageId();
      if (activePageId === "page-scripts") {
        await loadScriptsPage();
      } else if (activePageId === "page-runtime-logs") {
        await loadRuntimeLogs();
      } else {
        await refreshData();
      }
    } catch {}
  }
}, 10000);
