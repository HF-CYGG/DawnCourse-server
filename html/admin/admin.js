const overlay = document.getElementById("loginOverlay");
const loginBtn = document.getElementById("loginBtn");
const loginHint = document.getElementById("loginHint");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const exportBtn = document.getElementById("exportBtn");
const filterSchool = document.getElementById("filterSchool");
const filterSystemType = document.getElementById("filterSystemType");
const filterFailureType = document.getElementById("filterFailureType");
const failureSummary = document.getElementById("failureSummary");
const summaryCards = document.getElementById("summaryCards");
const schoolTableBody = document.querySelector("#schoolTable tbody");
const failureTableBody = document.querySelector("#failureTable tbody");
const headerMeta = document.getElementById("headerMeta");
let currentData = null;
let eventSource = null;

const navItems = document.querySelectorAll(".nav-item");
const pageSections = document.querySelectorAll(".page-section");
const pageTitle = document.getElementById("pageTitle");

function ensureToastContainer() {
  let container = document.querySelector(".toast-container");
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
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
    toast.remove();
  });
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, level === "error" ? 15000 : 8000);
}

function closeAdminEvents() {
  if (!eventSource) return;
  try {
    eventSource.close();
  } catch {}
  eventSource = null;
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
      } else {
        page.classList.remove("active");
      }
    });
  });
});

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
    }
  } catch (e) {
    console.error("Failed to load config", e);
    showToast("error", "加载配置失败", e?.message || "网络错误");
  }
}

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
  write: "写入失败",
  rollback: "回滚失败",
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
function getSchoolInfo(data, schoolId) {
  return data.schoolInfoById?.[schoolId] || {};
}
function calcSuccessRate(success, failed, empty) {
  const total = success + failed + empty;
  if (total <= 0) return 0;
  return success / total;
}

function renderCards(data) {
  const metrics = data.metrics || {};
  const latestMetricsAt = data.latestMetricsAt || 0;
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
      title: "解析成功",
      value: formatCount(metrics.parse_success?.count),
      sub: `平均耗时 ${Number(metrics.parse_success?.latencyMsAvg || 0).toFixed(1)} ms`
    },
    {
      title: "解析失败",
      value: formatCount(metrics.parse_failed?.count),
      sub: `空结果 ${formatCount(metrics.parse_empty?.count)}`
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
    schoolTableBody.innerHTML = `<tr><td colspan="10" class="muted">暂无数据</td></tr>`;
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
  }
}

loginBtn.addEventListener("click", async () => {
  loginHint.textContent = "";
  const username = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value.trim();
  if (!username || !password) {
    loginHint.textContent = "请输入账号和密码";
    return;
  }
  const res = await fetch("/api/v1/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    loginHint.textContent = "账号或密码错误";
    return;
  }
  const result = await res.json();
  setToken(result.data.token);
  overlay.style.display = "none";
  connectAdminEvents();
  await refreshData();
});

refreshBtn.addEventListener("click", async () => {
  await refreshData();
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
      await refreshData();
    } catch {}
  }
}, 10000);
