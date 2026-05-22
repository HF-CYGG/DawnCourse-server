/**
 * 文件说明：Dawn Course 服务端运维后台前端脚本。
 * 负责导航切换、运维文案映射、数据拉取、页面渲染以及主要运维操作交互。
 */

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
const repairIssueMeta = document.getElementById("repairIssueMeta");
const repairIssueTableBody = document.querySelector("#repairIssueTable tbody");
const repairIssueDetail = document.getElementById("repairIssueDetail");
const repairIssueTimeline = document.getElementById("repairIssueTimeline");
const repairIssueDetailMeta = document.getElementById("repairIssueDetailMeta");
const repairIssueSelected = document.getElementById("repairIssueSelected");
const repairIssueLogStage = document.getElementById("repairIssueLogStage");
const repairIssueLogLevel = document.getElementById("repairIssueLogLevel");
const repairIssueLogReloadBtn = document.getElementById("repairIssueLogReloadBtn");
const repairIssueAutoRefresh = document.getElementById("repairIssueAutoRefresh");
const repairIssueFollowLogs = document.getElementById("repairIssueFollowLogs");
const repairIssueActions = document.getElementById("repairIssueActions");
const repairIssueActionsBtn = document.getElementById("repairIssueActionsBtn");
const repairIssueActionsMenu = document.getElementById("repairIssueActionsMenu");
const repairIssueProgressStageBadge = document.getElementById("repairIssueProgressStageBadge");
const repairIssueProgressHint = document.getElementById("repairIssueProgressHint");
const repairIssueProgressMetrics = document.getElementById("repairIssueProgressMetrics");
const repairIssueProgressSteps = document.getElementById("repairIssueProgressSteps");
const repairIssueOverviewGrid = document.getElementById("repairIssueOverviewGrid");
const repairIssueTimelineList = document.getElementById("repairIssueTimelineList");
const repairIssueLogSearch = document.getElementById("repairIssueLogSearch");
const repairIssueClearSearchBtn = document.getElementById("repairIssueClearSearchBtn");
const repairIssueLogWrap = document.getElementById("repairIssueLogWrap");
const repairIssueLogSummary = document.getElementById("repairIssueLogSummary");
const repairIssueLogTable = document.getElementById("repairIssueLogTable");
const repairIssueCopyLogsBtn = document.getElementById("repairIssueCopyLogsBtn");
const testSummaryConfigBtn = document.getElementById("testSummaryConfigBtn");
const testSummaryConfigResult = document.getElementById("testSummaryConfigResult");
const testScriptConfigBtn = document.getElementById("testScriptConfigBtn");
const testScriptConfigResult = document.getElementById("testScriptConfigResult");
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
const dashboardSummaryPanel = document.getElementById("dashboardSummaryPanel");
const schoolTableMeta = document.getElementById("schoolTableMeta");
const failureTableMeta = document.getElementById("failureTableMeta");
const pullScriptTableMeta = document.getElementById("pullScriptTableMeta");
const scriptReleaseGuide = document.getElementById("scriptReleaseGuide");
const scriptReleaseMeta = document.getElementById("scriptReleaseMeta");
const runtimeLogSummaryCards = document.getElementById("runtimeLogSummaryCards");
const runtimeLogCallout = document.getElementById("runtimeLogCallout");
const pageRefreshStatus = document.getElementById("pageRefreshStatus");
const repairIssueRefreshRule = document.getElementById("repairIssueRefreshRule");
const confirmOverlay = document.getElementById("confirmOverlay");
const confirmKicker = document.getElementById("confirmKicker");
const confirmTitle = document.getElementById("confirmTitle");
const confirmDetail = document.getElementById("confirmDetail");
const confirmEmphasis = document.getElementById("confirmEmphasis");
const confirmInputGroup = document.getElementById("confirmInputGroup");
const confirmInput = document.getElementById("confirmInput");
const confirmInputHint = document.getElementById("confirmInputHint");
const confirmFeedback = document.getElementById("confirmFeedback");
const confirmCloseBtn = document.getElementById("confirmCloseBtn");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const confirmSubmitBtn = document.getElementById("confirmSubmitBtn");
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
let activeRepairIssueId = "";
let activeEventStreamToken = "";
let repairIssuesListCache = [];
let repairIssueDetailCache = null;
let repairIssueTimelineCache = [];
let repairIssueLogsCache = [];
let repairIssueAutoRefreshTimer = null;
const GLOBAL_AUTO_REFRESHABLE_PAGES = new Set(["page-dashboard", "page-scripts", "page-runtime-logs"]);
let pageRefreshState = {
  pageId: "page-dashboard",
  source: "idle",
  status: "idle",
  updatedAt: 0,
  detail: "等待首次刷新"
};
const confirmDialogState = {
  resolver: null,
  requireText: "",
  busy: false
};

function closeAllDropdowns() {
  document.querySelectorAll(".dropdown.open").forEach((el) => el.classList.remove("open"));
  if (floatingMenu) {
    floatingMenu.remove();
    floatingMenu = null;
  }
}

document.addEventListener("click", (e) => {
  const inside = e.target.closest(".dropdown");
  if (!inside) closeAllDropdowns();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllDropdowns();
});
window.addEventListener("scroll", () => closeAllDropdowns(), true);
window.addEventListener("resize", () => closeAllDropdowns(), true);
if (confirmCloseBtn) {
  confirmCloseBtn.addEventListener("click", () => closeConfirmDialog(false));
}
if (confirmCancelBtn) {
  confirmCancelBtn.addEventListener("click", () => closeConfirmDialog(false));
}
if (confirmSubmitBtn) {
  confirmSubmitBtn.addEventListener("click", () => submitConfirmDialog());
}
if (confirmInput) {
  confirmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitConfirmDialog();
    }
  });
}
if (confirmOverlay) {
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) {
      closeConfirmDialog(false);
    }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && confirmOverlay?.style.display !== "none" && confirmDialogState.resolver) {
    closeConfirmDialog(false);
  }
});

let floatingMenu = null;

function buildIssueActionsMenuHtml(mode) {
  const items = [];
  if (mode === "detail") {
    items.push(`<button class="dropdown-item" type="button" data-action="issue-copy-summary">复制问题摘要</button>`);
  }
  items.push(`<button class="dropdown-item" type="button" data-action="issue-run-test">执行复现</button>`);
  items.push(`<button class="dropdown-item" type="button" data-action="issue-retry">重试修复</button>`);
  items.push(`<button class="dropdown-item danger" type="button" data-action="issue-force-repair">立即修复</button>`);
  items.push(`<div class="dropdown-sep"></div>`);
  items.push(`<button class="dropdown-item danger" type="button" data-action="issue-delete">删除问题</button>`);
  return items.join("");
}

function openFloatingMenu(anchorEl, { mode, issueId }) {
  closeAllDropdowns();
  if (!anchorEl) return;
  const el = document.createElement("div");
  el.className = "dropdown-menu dropdown-float";
  el.dataset.mode = (mode || "row").toString();
  el.dataset.issueId = (issueId || "").toString();
  el.innerHTML = buildIssueActionsMenuHtml(el.dataset.mode);
  document.body.appendChild(el);
  floatingMenu = el;

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = el.getBoundingClientRect();
  const padding = 10;
  const maxLeft = Math.max(padding, window.innerWidth - menuRect.width - padding);
  const left = Math.min(Math.max(padding, rect.right - menuRect.width), maxLeft);
  const maxTop = Math.max(padding, window.innerHeight - menuRect.height - padding);
  const preferBelow = rect.bottom + 8 + menuRect.height <= window.innerHeight - padding;
  const top = preferBelow ? rect.bottom + 8 : Math.min(Math.max(padding, rect.top - 8 - menuRect.height), maxTop);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = (btn.dataset.action || "").toString();
    const activeId = (el.dataset.issueId || "").toString();
    if (!activeId) {
      closeAllDropdowns();
      showToast("warning", "未选择修复问题", "请先选择一条修复问题");
      return;
    }
    try {
      await withButtonLoading(btn, "处理中...", async () => {
        if (action === "issue-copy-summary") {
          const text = buildRepairIssueSummaryText(repairIssueDetailCache, repairIssueTimelineCache, repairIssueLogsCache).trim();
          if (!text) {
            showToast("warning", "暂无摘要", "请先选择一条修复问题");
            return;
          }
          await copyText(text);
          showToast("info", "已复制", "问题摘要已复制到剪贴板");
        } else if (action === "issue-run-test") {
          await runRepairIssueReplay(activeId);
        } else if (action === "issue-retry") {
          await retryRepairIssueFromAdmin(activeId);
        } else if (action === "issue-force-repair") {
          await forceRepairIssueFromAdmin(activeId);
        } else if (action === "issue-delete") {
          await deleteRepairIssueFromAdmin(activeId);
        }
      });
      closeAllDropdowns();
    } catch (err) {
      closeAllDropdowns();
      showToast("error", "操作失败", err?.message || "网络错误");
    }
  });
}

const navItems = document.querySelectorAll(".nav-item");
const pageSections = document.querySelectorAll(".page-section");
const pageTitle = document.getElementById("pageTitle");
// 页面元信息统一收口在这里，避免导航、页签标题与页面标题出现语义不一致。
const PAGE_METADATA = {
  "page-dashboard": { title: "总览监控", browserTitle: "Dawn Course 运维后台 - 总览监控" },
  "page-scripts": { title: "脚本发布", browserTitle: "Dawn Course 运维后台 - 脚本发布" },
  "page-repair-issues": { title: "修复问题", browserTitle: "Dawn Course 运维后台 - 修复问题" },
  "page-config": { title: "模型配置", browserTitle: "Dawn Course 运维后台 - 模型配置" },
  "page-users": { title: "账号管理", browserTitle: "Dawn Course 运维后台 - 账号管理" },
  "page-runtime-logs": { title: "运行日志", browserTitle: "Dawn Course 运维后台 - 运行日志" }
};

// 修复流水线阶段顺序：用于进度条与时间线可视化展示
const REPAIR_STAGE_FLOW = [
  { stage: "REPORT_RECEIVED", label: "收到失败上报" },
  { stage: "ISSUE_MERGED", label: "归并修复问题" },
  { stage: "QUEUED", label: "排队等待修复" },
  { stage: "REPLAY_RUNNING", label: "问题复现中" },
  { stage: "REPLAY_RESULT", label: "问题复现结果" },
  { stage: "CANDIDATE_TEST_RUNNING", label: "自动修复处理中" },
  { stage: "CANDIDATE_TEST_RESULT", label: "自动修复结果" },
  { stage: "PENDING_RELEASE", label: "待人工发布" },
  { stage: "PUBLISHED", label: "已发布" },
  { stage: "ROLLED_BACK", label: "已回滚" },
  { stage: "DISABLED", label: "已禁用" }
];

const REPAIR_FINAL_STAGES = new Set(["PUBLISHED", "ROLLED_BACK", "DISABLED"]);

/**
 * 将一组别名字段归一化为第一个可用值
 *
 * 说明：
 * - 后台历史数据与新接口可能同时存在 camelCase / snake_case
 * - 前端统一在这里做兜底，避免各个渲染函数里散落兼容判断
 */
function pickDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function normalizeScriptMeta(meta, fallback = {}) {
  const info = meta && typeof meta === "object" ? meta : {};
  return {
    ...info,
    scriptName: `${pickDefinedValue(info.scriptName, info.script_name, fallback.scriptName, fallback.script_name) || ""}`,
    version: Number(pickDefinedValue(info.version, fallback.version, fallback.scriptVersion, fallback.script_version) || 0),
    parentVersion: Number(
      pickDefinedValue(info.parentVersion, info.parent_version, fallback.parentVersion, fallback.parent_version) || 0
    ),
    releaseStage: `${pickDefinedValue(info.releaseStage, info.release_stage, fallback.releaseStage, fallback.release_stage) || ""}`,
    updatedAt: Number(pickDefinedValue(info.updatedAt, info.updated_at, fallback.updatedAt, fallback.updated_at) || 0),
    appliedBy: `${pickDefinedValue(info.appliedBy, info.applied_by, fallback.appliedBy, fallback.applied_by) || ""}`,
    contentSource: `${pickDefinedValue(info.contentSource, info.content_source, fallback.contentSource, fallback.content_source) || ""}`,
    resolvedVersion: Number(
      pickDefinedValue(info.resolvedVersion, info.resolved_version, fallback.resolvedVersion, fallback.resolved_version) || 0
    )
  };
}

function normalizeScriptListItem(item) {
  const info = item && typeof item === "object" ? item : {};
  const meta = normalizeScriptMeta(info.meta || info.scriptMeta || info.script_meta || {}, info);
  return {
    ...info,
    scriptName: `${pickDefinedValue(info.scriptName, info.script_name, meta.scriptName) || ""}`,
    meta,
    pendingAvailable: pickDefinedValue(info.pendingAvailable, info.pending_available, false) === true,
    rollbackAvailable: pickDefinedValue(info.rollbackAvailable, info.rollback_available, false) === true,
    rollbackTargetVersion: Number(
      pickDefinedValue(info.rollbackTargetVersion, info.rollback_target_version, meta.parentVersion) || 0
    ),
    recentFailureCount: Number(pickDefinedValue(info.recentFailureCount, info.recent_failure_count) || 0)
  };
}

function normalizeScriptHistoryEntry(item) {
  const info = item && typeof item === "object" ? item : {};
  const meta = normalizeScriptMeta(info.meta || info.scriptMeta || info.script_meta || {}, info);
  return {
    ...info,
    type: `${pickDefinedValue(info.type, info.eventType, info.event_type) || ""}`,
    appliedBy: `${pickDefinedValue(info.appliedBy, info.applied_by, meta.appliedBy) || ""}`,
    schoolId: `${pickDefinedValue(info.schoolId, info.school_id) || ""}`,
    releaseStage: `${pickDefinedValue(info.releaseStage, info.release_stage, meta.releaseStage) || ""}`,
    createdAt: Number(pickDefinedValue(info.createdAt, info.created_at, meta.updatedAt) || 0),
    meta,
    context: info.context || info.ctx || info.extra || {},
    failure: info.failure || info.failureInfo || info.failure_info || null
  };
}

function normalizeParserAttemptRecord(item) {
  const info = item && typeof item === "object" ? item : {};
  return {
    ...info,
    parserName: `${pickDefinedValue(info.parserName, info.parser_name) || ""}`,
    parserVersion: Number(pickDefinedValue(info.parserVersion, info.parser_version) || 0),
    scriptSource: `${pickDefinedValue(info.scriptSource, info.script_source) || ""}`,
    durationMs: Number(pickDefinedValue(info.durationMs, info.duration_ms) || 0),
    resultCount: Number(pickDefinedValue(info.resultCount, info.result_count) || 0),
    safeErrorCode: `${pickDefinedValue(info.safeErrorCode, info.safe_error_code) || ""}`,
    schemaValid:
      typeof pickDefinedValue(info.schemaValid, info.schema_valid) === "boolean"
        ? pickDefinedValue(info.schemaValid, info.schema_valid)
        : null,
    confidence: Number(pickDefinedValue(info.confidence) || 0)
  };
}

function normalizeRepairIssueRecord(item) {
  const info = item && typeof item === "object" ? item : {};
  const lastAttempt = normalizeParserAttemptRecord(info.lastAttempt || info.last_attempt || {});
  return {
    ...info,
    issueId: `${pickDefinedValue(info.issueId, info.issue_id) || ""}`,
    schoolId: `${pickDefinedValue(info.schoolId, info.school_id) || ""}`,
    schoolName: `${pickDefinedValue(info.schoolName, info.school_name) || ""}`,
    schoolSystemType: `${pickDefinedValue(info.schoolSystemType, info.school_system_type) || "unknown"}`,
    sourceUrlHost: `${pickDefinedValue(
      info.displaySourceHost,
      info.display_source_host,
      info.sourceUrlHost,
      info.source_url_host
    ) || ""}`,
    affectedScriptId: `${pickDefinedValue(info.affectedScriptId, info.affected_script_id, lastAttempt.parserName) || ""}`,
    affectedVersion: Number(pickDefinedValue(info.affectedVersion, info.affected_version, lastAttempt.parserVersion) || 0),
    failureType: `${pickDefinedValue(info.failureType, info.failure_type) || "unknown"}`,
    sampleCount: Number(pickDefinedValue(info.sampleCount, info.sample_count) || 0),
    userCount: Number(pickDefinedValue(info.userCount, info.user_count) || 0),
    priority: `${pickDefinedValue(info.priority) || "P2"}`,
    status: `${pickDefinedValue(info.status) || "open"}`,
    currentStage: `${pickDefinedValue(info.currentStage, info.current_stage) || ""}`,
    lastStepAt: Number(pickDefinedValue(info.lastStepAt, info.last_step_at, info.updatedAt, info.updated_at) || 0),
    lastSeenAt: Number(pickDefinedValue(info.lastSeenAt, info.last_seen_at, info.updatedAt, info.updated_at) || 0),
    updatedAt: Number(pickDefinedValue(info.updatedAt, info.updated_at) || 0),
    lastErrorMessage: `${pickDefinedValue(info.lastErrorMessage, info.last_error_message) || ""}`,
    lastReplayStatus: `${pickDefinedValue(info.lastReplayStatus, info.last_replay_status) || ""}`,
    lastCandidateStatus: `${pickDefinedValue(info.lastCandidateStatus, info.last_candidate_status) || ""}`,
    lastStatusCode: Number(pickDefinedValue(info.lastStatusCode, info.last_status_code) || 0),
    lastErrorCode: `${pickDefinedValue(info.lastErrorCode, info.last_error_code, lastAttempt.safeErrorCode) || ""}`,
    lastDurationMs: Number(pickDefinedValue(info.lastDurationMs, info.last_duration_ms, lastAttempt.durationMs) || 0),
    lastParserName: `${pickDefinedValue(info.lastParserName, info.last_parser_name, lastAttempt.parserName) || ""}`,
    lastParserVersion: Number(
      pickDefinedValue(info.lastParserVersion, info.last_parser_version, lastAttempt.parserVersion) || 0
    ),
    lastScriptSource: `${pickDefinedValue(info.lastScriptSource, info.last_script_source, lastAttempt.scriptSource) || ""}`,
    lastResultCount: Number(pickDefinedValue(info.lastResultCount, info.last_result_count, lastAttempt.resultCount) || 0),
    lastConfidence: Number(pickDefinedValue(info.lastConfidence, info.last_confidence, lastAttempt.confidence) || 0),
    lastSchemaValid:
      typeof pickDefinedValue(info.lastSchemaValid, info.last_schema_valid) === "boolean"
        ? pickDefinedValue(info.lastSchemaValid, info.last_schema_valid)
        : lastAttempt.schemaValid,
    lastAttempt
  };
}

function normalizeRepairTraceMeta(meta) {
  const info = meta && typeof meta === "object" ? meta : {};
  return {
    ...info,
    modelRole: `${pickDefinedValue(info.modelRole, info.model_role) || ""}`,
    llmStage: `${pickDefinedValue(info.llmStage, info.llm_stage, info.stageId, info.stage_id) || ""}`,
    llmStageLabel: `${pickDefinedValue(info.llmStageLabel, info.llm_stage_label) || ""}`,
    action: `${pickDefinedValue(info.action, info.actionType, info.action_type) || ""}`,
    provider: `${pickDefinedValue(info.provider, info.providerName, info.provider_name) || ""}`,
    model: `${pickDefinedValue(info.model, info.modelName, info.model_name) || ""}`,
    scriptName: `${pickDefinedValue(info.scriptName, info.script_name) || ""}`,
    previousVersion: Number(pickDefinedValue(info.previousVersion, info.previous_version) || 0),
    sampleCount: Number(pickDefinedValue(info.sampleCount, info.sample_count) || 0),
    includedSamples: Number(pickDefinedValue(info.includedSamples, info.included_samples) || 0),
    droppedSamples: Number(pickDefinedValue(info.droppedSamples, info.dropped_samples) || 0),
    truncatedSamples: Number(pickDefinedValue(info.truncatedSamples, info.truncated_samples) || 0),
    inputChars: Number(pickDefinedValue(info.inputChars, info.input_chars) || 0),
    originalInputChars: Number(pickDefinedValue(info.originalInputChars, info.original_input_chars) || 0),
    timeoutBudgetMs: Number(pickDefinedValue(info.timeoutBudgetMs, info.timeout_budget_ms) || 0),
    summaryChars: Number(pickDefinedValue(info.summaryChars, info.summary_chars) || 0),
    originalSummaryChars: Number(pickDefinedValue(info.originalSummaryChars, info.original_summary_chars) || 0),
    guidanceChars: Number(pickDefinedValue(info.guidanceChars, info.guidance_chars) || 0),
    originalGuidanceChars: Number(pickDefinedValue(info.originalGuidanceChars, info.original_guidance_chars) || 0),
    previousScriptChars: Number(pickDefinedValue(info.previousScriptChars, info.previous_script_chars) || 0),
    originalPreviousScriptChars: Number(
      pickDefinedValue(info.originalPreviousScriptChars, info.original_previous_script_chars) || 0
    ),
    truncatedSummary: pickDefinedValue(info.truncatedSummary, info.truncated_summary) === true,
    truncatedGuidance: pickDefinedValue(info.truncatedGuidance, info.truncated_guidance) === true,
    truncatedPreviousScript: pickDefinedValue(info.truncatedPreviousScript, info.truncated_previous_script) === true,
    previousScriptExtracted:
      pickDefinedValue(info.previousScriptExtracted, info.previous_script_extracted) === true,
    contextStrategy: `${pickDefinedValue(info.contextStrategy, info.context_strategy) || ""}`,
    inputClipStrategy: `${pickDefinedValue(info.inputClipStrategy, info.input_clip_strategy, info.clipStrategy, info.clip_strategy) || ""}`,
    summaryClipStrategy: `${pickDefinedValue(info.summaryClipStrategy, info.summary_clip_strategy) || ""}`,
    guidanceClipStrategy: `${pickDefinedValue(info.guidanceClipStrategy, info.guidance_clip_strategy) || ""}`,
    previousScriptClipStrategy: `${pickDefinedValue(info.previousScriptClipStrategy, info.previous_script_clip_strategy) || ""}`,
    statusCode: Number(pickDefinedValue(info.statusCode, info.status_code) || 0),
    errorCode: `${pickDefinedValue(info.errorCode, info.error_code) || ""}`,
    latencyMs: Number(pickDefinedValue(info.latencyMs, info.latency_ms, info.durationMs, info.duration_ms) || 0),
    lastAttemptLatencyMs: Number(
      pickDefinedValue(info.lastAttemptLatencyMs, info.last_attempt_latency_ms, info.attemptLatencyMs, info.attempt_latency_ms) || 0
    ),
    maxAttempts: Number(pickDefinedValue(info.maxAttempts, info.max_attempts) || 0),
    attemptsUsed: Number(pickDefinedValue(info.attemptsUsed, info.attempts_used) || 0),
    retryCount: Number(pickDefinedValue(info.retryCount, info.retry_count) || 0),
    retryPolicy: `${pickDefinedValue(info.retryPolicy, info.retry_policy) || ""}`,
    repairRound: Number(pickDefinedValue(info.repairRound, info.repair_round) || 0),
    failureType: `${pickDefinedValue(info.failureType, info.failure_type) || ""}`,
    failureReason: `${pickDefinedValue(info.failureReason, info.failure_reason) || ""}`,
    fallbackPath: `${pickDefinedValue(info.fallbackPath, info.fallback_path) || ""}`,
    manualSuggestion: `${pickDefinedValue(info.manualSuggestion, info.manual_suggestion) || ""}`,
    scriptRepairMode: `${pickDefinedValue(info.scriptRepairMode, info.script_repair_mode, info.repairMode, info.repair_mode) || ""}`,
    opsApplied: pickDefinedValue(info.opsApplied, info.ops_applied) === true,
    opsCount: Number(pickDefinedValue(info.opsCount, info.ops_count) || 0),
    opsMissedCount: Number(pickDefinedValue(info.opsMissedCount, info.ops_missed_count) || 0),
    opsMissedNames: `${pickDefinedValue(info.opsMissedNames, info.ops_missed_names) || ""}`,
    opsApplyFailureReason: `${pickDefinedValue(info.opsApplyFailureReason, info.ops_apply_failure_reason) || ""}`,
    cacheHit: pickDefinedValue(info.cacheHit, info.cache_hit) === true,
    releaseStage: `${pickDefinedValue(info.releaseStage, info.release_stage) || ""}`,
    ok: pickDefinedValue(info.ok, info.success) === true
  };
}

function normalizeRepairTraceEntry(item) {
  const info = item && typeof item === "object" ? item : {};
  return {
    ...info,
    stepId: `${pickDefinedValue(info.stepId, info.step_id) || ""}`,
    stage: `${pickDefinedValue(info.stage) || ""}`,
    ts: Number(pickDefinedValue(info.ts, info.createdAt, info.created_at) || 0),
    level: `${pickDefinedValue(info.level) || "info"}`,
    message: `${pickDefinedValue(info.message) || ""}`,
    durationMs: Number(pickDefinedValue(info.durationMs, info.duration_ms) || 0),
    actor: `${pickDefinedValue(info.actor, info.operator) || ""}`,
    source: `${pickDefinedValue(info.source) || ""}`,
    meta: normalizeRepairTraceMeta(info.meta || info.extra || {})
  };
}

function normalizeRuntimeLogPayload(data, requestedSource, requestedLimit) {
  const info = data && typeof data === "object" ? data : {};
  const lines = Array.isArray(info.lines) ? info.lines : [];
  const counts = info.sourceCounts || info.source_counts || {};
  const files = info.files || {};
  return {
    ...info,
    source: `${pickDefinedValue(info.source, info.requestedSource, info.requested_source, requestedSource) || "all"}`,
    requestedSource: `${pickDefinedValue(info.requestedSource, info.requested_source, requestedSource) || "all"}`,
    requestedLimit: Number(pickDefinedValue(info.requestedLimit, info.requested_limit, requestedLimit) || 0),
    loadedAt: Number(pickDefinedValue(info.loadedAt, info.loaded_at) || Date.now()),
    lineCount: Number(pickDefinedValue(info.lineCount, info.line_count, lines.length) || 0),
    sourceDetails: Array.isArray(info.sourceDetails || info.source_details) ? info.sourceDetails || info.source_details : [],
    lines,
    counts,
    files,
    missingSources: Array.isArray(info.missingSources || info.missing_sources) ? info.missingSources || info.missing_sources : []
  };
}

function renderRepairStageFilterOptions() {
  if (!repairIssueLogStage) return;
  repairIssueLogStage.innerHTML = [`<option value="">全部阶段</option>`]
    .concat(
      REPAIR_STAGE_FLOW.map((item) => `<option value="${item.stage}">${item.label} (${item.stage})</option>`)
    )
    .join("");
}

function getRepairStatusLabel(status) {
  const key = (status || "").toString().trim().toLowerCase();
  const map = {
    open: "待处理",
    pending: "待发布",
    published: "已发布",
    rolled_back: "已回滚",
    disabled: "已禁用"
  };
  return map[key] || (status || "-");
}

function getRepairStatusTone(status) {
  const key = (status || "").toString().trim().toLowerCase();
  if (key === "published") return "success";
  if (key === "pending" || key === "rolled_back") return "warning";
  if (key === "disabled") return "danger";
  return "";
}

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

function applyPageMetadata(pageId, fallbackTitle) {
  const meta = PAGE_METADATA[pageId] || {
    title: fallbackTitle || "运维后台",
    browserTitle: `Dawn Course 运维后台 - ${fallbackTitle || "运维后台"}`
  };
  if (pageTitle) {
    pageTitle.textContent = meta.title;
  }
  document.title = meta.browserTitle;
}

function formatRefreshSourceLabel(source) {
  const key = (source || "manual").toString();
  if (key === "initial") return "首次加载";
  if (key === "auto") return "自动刷新";
  if (key === "manual") return "手动刷新";
  return "刷新";
}

function getPageRefreshPolicyText(pageId) {
  const key = (pageId || "").toString();
  if (key === "page-repair-issues") {
    return `自动刷新由“自动刷新”开关控制；开启后每 2.5 秒静默更新当前问题，并保留已选问题、日志筛选、自动滚动与自动换行设置；手动刷新只执行一次，不会改动开关状态。`;
  }
  if (GLOBAL_AUTO_REFRESHABLE_PAGES.has(key)) {
    return "页面可在可见状态下每 10 秒自动刷新一次；手动刷新会立即执行一次，不会关闭自动刷新。";
  }
  return "当前页面仅支持手动刷新，不会在后台自动更新。";
}

function syncRepairIssueRefreshRule() {
  if (!repairIssueRefreshRule) return;
  const autoText = repairIssueAutoRefresh?.checked
    ? "当前已开启自动刷新，系统会静默更新当前问题。"
    : "当前已关闭自动刷新，仅在手动刷新时更新当前问题。";
  repairIssueRefreshRule.textContent =
    `${autoText} 手动刷新只执行一次，并保留当前选中项、日志筛选、自动滚动与自动换行设置。`;
}

function updatePageRefreshStatus({ pageId, source, status, detail, updatedAt } = {}) {
  const currentPageId = (pageId || getActivePageId() || pageRefreshState.pageId || "page-dashboard").toString();
  pageRefreshState = {
    pageId: currentPageId,
    source: (source || pageRefreshState.source || "idle").toString(),
    status: (status || pageRefreshState.status || "idle").toString(),
    detail: (detail || pageRefreshState.detail || "").toString(),
    updatedAt: updatedAt == null ? Date.now() : Number(updatedAt)
  };
  if (!pageRefreshStatus) return;
  const stateTextMap = {
    idle: "等待刷新",
    loading: "进行中",
    success: "已完成",
    error: "失败"
  };
  const rule = getPageRefreshPolicyText(currentPageId);
  const timeText = pageRefreshState.updatedAt ? formatTime(pageRefreshState.updatedAt) : "尚未刷新";
  pageRefreshStatus.textContent =
    `刷新状态：${formatRefreshSourceLabel(pageRefreshState.source)}${stateTextMap[pageRefreshState.status] || ""}，${timeText}。` +
    `${pageRefreshState.detail ? ` 结果：${pageRefreshState.detail}。` : ""} 规则：${rule}`;
}

function syncPageRefreshRuleForPage(pageId) {
  const key = (pageId || getActivePageId() || "page-dashboard").toString();
  if (pageRefreshState.pageId === key) {
    updatePageRefreshStatus(pageRefreshState);
    return;
  }
  updatePageRefreshStatus({
    pageId: key,
    source: "idle",
    status: "idle",
    detail: "等待进入当前页后的首次刷新",
    updatedAt: 0
  });
}

function setButtonLoading(button, loading, loadingText) {
  if (!button) return;
  if (loading) {
    button.dataset.prevDisabled = button.disabled ? "1" : "0";
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent || "";
    }
    button.dataset.loading = "1";
    button.disabled = true;
    if (loadingText) {
      button.textContent = loadingText;
    }
    return;
  }
  const wasDisabled = button.dataset.prevDisabled === "1";
  button.disabled = wasDisabled;
  button.dataset.loading = "0";
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
  delete button.dataset.prevDisabled;
}

async function withButtonLoading(button, loadingText, task) {
  setButtonLoading(button, true, loadingText);
  try {
    return await task();
  } finally {
    setButtonLoading(button, false);
  }
}

function closeConfirmDialog(confirmed) {
  if (!confirmOverlay || !confirmDialogState.resolver) return;
  const resolver = confirmDialogState.resolver;
  confirmDialogState.resolver = null;
  confirmDialogState.requireText = "";
  confirmDialogState.busy = false;
  confirmOverlay.style.display = "none";
  if (confirmFeedback) {
    confirmFeedback.textContent = "";
    confirmFeedback.classList.remove("error");
  }
  if (confirmInput) {
    confirmInput.value = "";
  }
  resolver(Boolean(confirmed));
}

function submitConfirmDialog() {
  if (!confirmOverlay || confirmOverlay.style.display === "none" || confirmDialogState.busy) return;
  const expectedText = (confirmDialogState.requireText || "").trim();
  const inputText = (confirmInput?.value || "").trim();
  if (expectedText && inputText !== expectedText) {
    if (confirmFeedback) {
      confirmFeedback.textContent = `确认文本不匹配，请输入：${expectedText}`;
      confirmFeedback.classList.add("error");
    }
    confirmInput?.focus();
    confirmInput?.select();
    return;
  }
  closeConfirmDialog(true);
}

async function askOperationConfirm(options = {}) {
  if (!confirmOverlay) {
    return window.confirm(`${options?.title || "确认操作"}\n${options?.detail || ""}`);
  }
  if (confirmDialogState.resolver) {
    closeConfirmDialog(false);
  }
  const title = (options.title || "确认操作").toString().trim();
  const detail = (options.detail || "确认后将执行对应操作。").toString().trim();
  const emphasizeText = (options.emphasizeText || "").toString().trim();
  const confirmText = (options.confirmText || "").toString().trim();
  if (confirmKicker) {
    confirmKicker.textContent = options.kicker || (options.danger ? "危险操作，请再次确认" : "请确认操作");
  }
  if (confirmTitle) confirmTitle.textContent = title;
  if (confirmDetail) confirmDetail.textContent = detail;
  if (confirmEmphasis) {
    confirmEmphasis.style.display = emphasizeText ? "block" : "none";
    confirmEmphasis.textContent = emphasizeText;
  }
  if (confirmInputGroup) {
    confirmInputGroup.style.display = confirmText ? "flex" : "none";
  }
  if (confirmInputHint) {
    confirmInputHint.textContent = confirmText ? `请输入上方文本：${confirmText}` : "";
  }
  if (confirmInput) {
    confirmInput.value = "";
    confirmInput.placeholder = confirmText ? "请输入确认文本" : "";
  }
  if (confirmFeedback) {
    confirmFeedback.textContent = "";
    confirmFeedback.classList.remove("error");
  }
  if (confirmSubmitBtn) {
    confirmSubmitBtn.textContent = options.confirmLabel || "确认执行";
    confirmSubmitBtn.classList.toggle("danger", options.danger !== false);
  }
  confirmDialogState.requireText = confirmText;
  confirmOverlay.style.display = "flex";
  requestAnimationFrame(() => {
    if (confirmText) {
      confirmInput?.focus();
    } else {
      confirmSubmitBtn?.focus();
    }
  });
  return await new Promise((resolve) => {
    confirmDialogState.resolver = resolve;
  });
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
    await connectAdminEvents();
    await performPageRefresh("page-dashboard", "initial");
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
  const safeTitle = escapeHtml((title || "提示").toString());
  const safeMessage = escapeHtml((message || "").toString());
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
  activeEventStreamToken = "";
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

async function connectAdminEvents() {
  const token = getToken();
  if (!token) return;
  closeAdminEvents();
  let streamToken = "";
  try {
    const result = await postWithAuth("/api/v1/admin/events/token", {});
    if (result.code !== 200 || !result?.data?.token) {
      throw new Error(result.msg || "无法创建事件令牌");
    }
    streamToken = result.data.token;
    activeEventStreamToken = streamToken;
  } catch (error) {
    const now = Date.now();
    if (now - lastEventStreamWarnAt >= 15000) {
      lastEventStreamWarnAt = now;
      showToast("warning", "事件流未连接", error?.message || "无法创建事件令牌");
    }
    return;
  }
  eventSource = new EventSource(`/api/v1/admin/events?streamToken=${encodeURIComponent(streamToken)}`);
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
    if (activeEventStreamToken !== streamToken) return;
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
    const prev = getActivePageId();
    if (prev === "page-repair-issues" && target !== "page-repair-issues") {
      stopRepairIssueAutoRefresh();
    }
    navItems.forEach((nav) => nav.classList.remove("active"));
    item.classList.add("active");
    applyPageMetadata(target, item.textContent.trim());
    syncPageRefreshRuleForPage(target);
    syncRepairIssueRefreshRule();

    pageSections.forEach((page) => {
      if (page.id === target) {
        page.classList.add("active");
        if (target === "page-config") performPageRefresh(target, "initial");
        if (target === "page-scripts") performPageRefresh(target, "initial");
        if (target === "page-repair-issues") {
          performPageRefresh(target, "initial");
          startRepairIssueAutoRefresh();
        }
        if (target === "page-users") performPageRefresh(target, "initial");
        if (target === "page-runtime-logs") performPageRefresh(target, "initial");
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
  if (value === "active") return `<span class="badge success">当前生效</span>`;
  if (value === "canary") return `<span class="badge warning">灰度发布</span>`;
  if (value === "pending") return `<span class="badge danger">待发布</span>`;
  if (value === "rollback") return `<span class="badge danger">回滚版本</span>`;
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
    const meta = normalizeScriptMeta(payload.meta || {}, {
      contentSource: payload.resolvedSource || payload.requestedSource || source
    });
    scriptModalState.currentMeta = meta || null;
    const resolvedSource = payload.resolvedSource || meta.contentSource || source;
    const versionText = meta.resolvedVersion || meta.version || 0;
    const pendingHint = meta.virtualVersion === true ? "（待发布候选，版本号为推断值）" : "";
    scriptModalMeta.textContent = `查看 ${formatScriptContentSourceLabel(resolvedSource)} | 阶段 ${formatReleaseStageText(
      meta.releaseStage || "-"
    )} | 版本 v${versionText}${pendingHint} | 父版本 ${meta.parentVersion ? `v${meta.parentVersion}` : "-"} | 更新时间 ${formatTime(
      meta.updatedAt
    )} | 操作人 ${meta.appliedBy || "-"}`;
    scriptModalCode.textContent = payload.content || "";
  } catch (e) {
    scriptModalCode.textContent = e?.message === "unauthorized" ? "未登录" : "加载失败";
  }
}

function historyTypeLabel(type) {
  const t = (type || "").toString();
  if (t === "auto_repair" || t === "apply") return "写入";
  if (t === "pending") return "待发布";
  if (t === "promote_active") return "发布全量";
  if (t === "promote_canary") return "灰度发布";
  if (t === "rollback_admin") return "回滚(人工)";
  if (t === "rollback_auto") return "回滚(自动)";
  if (t === "failure") return "失败";
  if (t === "skipped") return "跳过";
  return t || "事件";
}

function renderScriptHistory(list) {
  if (!scriptModalHistory) return;
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeScriptHistoryEntry(item));
  if (scriptModalHistoryMeta) {
    scriptModalHistoryMeta.textContent = items.length
      ? `最近 ${items.length} 条事件，点击左侧可切换查看对应版本或待发布内容`
      : "暂无历史事件";
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
      const tags = [
        stage ? stageBadge(stage) : "",
        meta?.version ? `<span class="badge">v${escapeHtml(meta.version)}</span>` : "",
        meta?.parentVersion ? `<span class="badge">父版本 v${escapeHtml(meta.parentVersion)}</span>` : "",
        failure ? `<span class="badge danger">${escapeHtml(formatFailureType(failure.failureType || "unknown"))}</span>` : ""
      ]
        .filter(Boolean)
        .join("");
      const metaLines = [
        item?.appliedBy ? `操作人：${item.appliedBy}` : "",
        item?.schoolId ? `学校：${item.schoolId}` : "",
        ctx?.mode ? `模式：${ctx.mode}` : "",
        ctx?.clusterSize ? `聚类：${ctx.clusterSize}` : "",
        categories.length ? `分类：${categories.join(",")}` : ""
      ].filter(Boolean);
      const detailLines = [
        ctx?.guidancePreview ? `修复指令：${ctx.guidancePreview}` : "",
        failure ? `失败详情：${failure.failureType || ""} ${failure.reason || ""}`.trim() : ""
      ].filter(Boolean);
      const badge = stage ? stageBadge(stage) : "";
      return `
        <div class="history-item ${isActive ? "active" : ""}" data-key="${encodeURIComponent(
          key
        )}" data-type="${encodeURIComponent(item?.type || "")}" data-version="${Number(meta?.version || 0)}" data-stage="${encodeURIComponent(
          stage
        )}">
          <div class="history-item-title">
            <div class="history-item-headline">${badge} ${escapeHtml(titleLeft)}</div>
            <div class="muted">${titleRight}</div>
          </div>
          <div class="history-item-tags">${tags}</div>
          <div class="history-item-meta">${escapeHtml(metaLines.join(" | ") || "暂无额外上下文")}</div>
          <div class="history-item-meta">${escapeHtml(detailLines.join(" | ") || "点击可切换查看对应脚本内容")}</div>
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
      const summaryTimeoutEl = document.getElementById("conf_summaryTimeoutMs");
      if (summaryTimeoutEl) summaryTimeoutEl.value = conf.summaryTimeoutMs || conf.timeoutMs || "";
      const patchTimeoutEl = document.getElementById("conf_patchGuidanceTimeoutMs");
      if (patchTimeoutEl) patchTimeoutEl.value = conf.patchGuidanceTimeoutMs || conf.timeoutMs || "";

      document.getElementById("conf_scriptProviderRaw").value = conf.scriptProviderRaw || "auto";
      document.getElementById("conf_scriptModelRaw").value = conf.scriptModelRaw || "";
      document.getElementById("conf_scriptApiKey").value = conf.scriptApiKey || "";
      document.getElementById("conf_scriptBaseUrl").value = conf.scriptBaseUrl || "";
      document.getElementById("conf_scriptApiStyleRaw").value = conf.scriptApiStyleRaw || "";
      document.getElementById("conf_scriptRequestExtraJson").value =
        conf.scriptRequestExtraJson || "";
      const scriptTimeoutEl = document.getElementById("conf_scriptTimeoutMs");
      if (scriptTimeoutEl) scriptTimeoutEl.value = conf.scriptTimeoutMs || conf.timeoutMs || "";

      document.getElementById("conf_modelAliasJson").value = conf.modelAliasJson || "";
      document.getElementById("conf_usageEnabled").checked = conf.usageEnabled;
      document.getElementById("conf_summaryUsageUrl").value = conf.summaryUsageUrl || "";
      document.getElementById("conf_summaryCostUrl").value = conf.summaryCostUrl || "";
      document.getElementById("conf_scriptUsageUrl").value = conf.scriptUsageUrl || "";
      document.getElementById("conf_scriptCostUrl").value = conf.scriptCostUrl || "";
      const publicBaseUrlEl = document.getElementById("conf_publicBaseUrl");
      if (publicBaseUrlEl) publicBaseUrlEl.value = conf.publicBaseUrl || "";
      const runnerUrlEl = document.getElementById("conf_runnerUrl");
      if (runnerUrlEl) runnerUrlEl.value = conf.runnerUrl || "";
      const minQueueSizeEl = document.getElementById("conf_minQueueSize");
      if (minQueueSizeEl) minQueueSizeEl.value = conf.minQueueSize || "";
      const runnerTimeoutMsEl = document.getElementById("conf_runnerTimeoutMs");
      if (runnerTimeoutMsEl) runnerTimeoutMsEl.value = conf.runnerTimeoutMs || "";
      const signingPublicKeyEl = document.getElementById("conf_signingPublicKey");
      if (signingPublicKeyEl) signingPublicKeyEl.value = conf.signing?.publicKey || "";
      const runtimeStatusEl = document.getElementById("conf_runtimeStatus");
      if (runtimeStatusEl) {
        runtimeStatusEl.textContent = [
          `数据库 ${conf.runtime?.databaseConfigured ? "已配置" : "未配置"}`,
          `Redis ${conf.runtime?.redisConfigured ? "已配置" : "未配置"}`,
          `Runner ${conf.runtime?.runnerUrl || "-"}`,
          `签名 ${conf.signing?.configured ? "可用" : "不可用"}`,
          conf.signing?.generated ? "密钥由容器自动生成" : "密钥来自环境变量或持久化文件"
        ].join(" | ");
      }

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
      if (testSummaryConfigResult) testSummaryConfigResult.textContent = "-";
      if (testScriptConfigResult) testScriptConfigResult.textContent = "-";
    }
  } catch (e) {
    console.error("Failed to load config", e);
    showToast("error", "加载配置失败", e?.message || "网络错误");
  }
}

function buildModelTestPayload(target) {
  const summary = target === "summary";
  return {
    target: summary ? "model1" : "model2",
    provider: document.getElementById(summary ? "conf_summaryProviderRaw" : "conf_scriptProviderRaw").value,
    model: document.getElementById(summary ? "conf_summaryModelRaw" : "conf_scriptModelRaw").value,
    apiKey: document.getElementById(summary ? "conf_summaryApiKey" : "conf_scriptApiKey").value,
    baseUrl: document.getElementById(summary ? "conf_summaryBaseUrl" : "conf_scriptBaseUrl").value,
    apiStyle: document.getElementById(summary ? "conf_summaryApiStyleRaw" : "conf_scriptApiStyleRaw").value,
    extraBody: document.getElementById(summary ? "conf_summaryRequestExtraJson" : "conf_scriptRequestExtraJson").value,
    timeoutMs: Number(
      document.getElementById(summary ? "conf_summaryTimeoutMs" : "conf_scriptTimeoutMs")?.value || 0
    ) || undefined
  };
}

function renderModelTestResult(target, data) {
  const resultEl = target === "summary" ? testSummaryConfigResult : testScriptConfigResult;
  if (!resultEl) return;
  if (!data) {
    resultEl.textContent = "测试失败";
    return;
  }
  if (data.ok) {
    resultEl.textContent = `可用 · ${data.statusCode || 200} · ${Number(data.latencyMs || 0)}ms`;
  } else {
    resultEl.textContent = `失败 · ${data.statusCode || 0} · ${data.errorCode || "unknown"} · ${
      data.errorMessage || "-"
    }`;
  }
}

async function runModelConnectionTest(target) {
  const btn = target === "summary" ? testSummaryConfigBtn : testScriptConfigBtn;
  if (!btn) return;
  const payload = buildModelTestPayload(target);
  const originalText = btn.textContent;
  btn.textContent = "测试中...";
  btn.disabled = true;
  renderModelTestResult(target, null);
  try {
    const result = await postWithAuth("/api/v1/admin/config/test", payload);
    if (result.code !== 200) {
      throw new Error(result.msg || "测试接口失败");
    }
    renderModelTestResult(target, result.data || {});
    if (result.data?.ok) {
      showToast("info", "模型测试成功", `${result.data.provider}/${result.data.model} 可用`);
    } else {
      showToast("warning", "模型测试失败", result.data?.errorMessage || result.data?.errorCode || "未知错误");
    }
  } catch (error) {
    renderModelTestResult(target, {
      ok: false,
      statusCode: 0,
      errorCode: "request_failed",
      errorMessage: error?.message || "网络错误"
    });
    showToast("error", "模型测试失败", error?.message || "网络错误");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
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
    summaryTimeoutMs: Number(document.getElementById("conf_summaryTimeoutMs")?.value || 0) || "",
    patchGuidanceTimeoutMs: Number(document.getElementById("conf_patchGuidanceTimeoutMs")?.value || 0) || "",

    scriptProviderRaw: document.getElementById("conf_scriptProviderRaw").value,
    scriptModelRaw: document.getElementById("conf_scriptModelRaw").value,
    scriptApiKey: document.getElementById("conf_scriptApiKey").value,
    scriptBaseUrl: document.getElementById("conf_scriptBaseUrl").value,
    scriptApiStyleRaw: document.getElementById("conf_scriptApiStyleRaw").value,
    scriptRequestExtraJson: document.getElementById("conf_scriptRequestExtraJson").value,
    scriptTimeoutMs: Number(document.getElementById("conf_scriptTimeoutMs")?.value || 0) || "",

    modelAliasJson: document.getElementById("conf_modelAliasJson").value,
    usageEnabled: document.getElementById("conf_usageEnabled").checked,
    summaryUsageUrl: document.getElementById("conf_summaryUsageUrl").value,
    summaryCostUrl: document.getElementById("conf_summaryCostUrl").value,
    scriptUsageUrl: document.getElementById("conf_scriptUsageUrl").value,
    scriptCostUrl: document.getElementById("conf_scriptCostUrl").value,
    publicBaseUrl: document.getElementById("conf_publicBaseUrl")?.value || "",
    runnerUrl: document.getElementById("conf_runnerUrl")?.value || "",
    minQueueSize: Number(document.getElementById("conf_minQueueSize")?.value || 0) || "",
    runnerTimeoutMs: Number(document.getElementById("conf_runnerTimeoutMs")?.value || 0) || ""
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
if (testSummaryConfigBtn) {
  testSummaryConfigBtn.addEventListener("click", async () => {
    await runModelConnectionTest("summary");
  });
}
if (testScriptConfigBtn) {
  testScriptConfigBtn.addEventListener("click", async () => {
    await runModelConnectionTest("script");
  });
}

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
async function copyText(text) {
  const value = (text ?? "").toString();
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
function formatTime(ts) {
  if (!ts) return "-";
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const totalSeconds = Math.floor(value / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
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
// 发布阶段、运行日志来源与脚本内容来源都属于内部技术值，这里统一转换成运维可直接理解的中文语义。
function formatReleaseStageText(value) {
  const key = (value || "unknown").toString();
  if (key === "active") return "当前生效";
  if (key === "canary") return "灰度发布";
  if (key === "pending") return "待发布";
  if (key === "rollback") return "回滚版本";
  return key || "未知";
}
function formatRuntimeLogSourceName(value) {
  const key = (value || "all").toString();
  if (key === "backend") return "llm-backend";
  if (key === "nginx_access") return "nginx 访问日志";
  if (key === "nginx_error") return "nginx 错误日志";
  if (key === "admin") return "管理后台缓存";
  return "全部来源";
}
function formatRuntimeLogSourceTag(value) {
  const key = (value || "").toString();
  if (key === "backend") return "后端";
  if (key === "nginx_access") return "nginx访问";
  if (key === "nginx_error") return "nginx错误";
  if (key === "admin") return "后台缓存";
  return key || "未知来源";
}
function formatScriptContentSourceLabel(value) {
  const key = (value || "current").toString();
  if (key === "pending") return "待发布版本";
  if (key === "backup") return "父版本备份";
  return "当前版本";
}
function formatScriptSourceLabel(value) {
  const key = (value || "").toString();
  if (key === "cloud_primary") return "云端主源";
  if (key === "cloud_fallback") return "云端备用源";
  if (key === "local_cache") return "本地缓存";
  if (key === "assets") return "内置脚本";
  return key || "-";
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
// 高密度表格统一采用“主信息 + 次说明”的输出结构，避免只堆技术字段导致阅读成本过高。
function buildInfoLine(main, sub) {
  const mainText = `${main ?? ""}`.trim() || "-";
  const subText = `${sub ?? ""}`.trim();
  return `
    <div class="cell-main">${escapeHtml(mainText)}</div>
    <div class="cell-sub">${escapeHtml(subText || "-")}</div>
  `;
}
function buildBadgeLine(text, tone, sub) {
  const cls = tone ? `badge ${tone}` : "badge";
  return `
    <div class="cell-badge-line"><span class="${cls}">${escapeHtml(`${text ?? "-"}`)}</span></div>
    <div class="cell-sub">${escapeHtml(`${sub ?? "-"}`)}</div>
  `;
}
function getFilteredSchoolEntries(data, filters) {
  const entries = Object.entries(data.schoolMetrics || {});
  entries.sort((a, b) => (b[1].lastUpdatedAt || 0) - (a[1].lastUpdatedAt || 0));
  return entries.filter(([schoolId]) => {
    const info = getSchoolInfo(data, schoolId);
    if (filters.schoolId && schoolId !== filters.schoolId) return false;
    if (filters.systemType && (info.schoolSystemType || "unknown") !== filters.systemType) {
      return false;
    }
    return true;
  });
}
function getFilteredFailureItems(data, filters) {
  return (data.failures || [])
    .filter((item) => {
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
    })
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
}
// 总览页顶部摘要负责把当前筛选上下文、排队压力和高频失败收束成一段可快速浏览的信息。
function renderDashboardSummary(data, schoolEntries, failureList, filters) {
  if (!dashboardSummaryPanel) return;
  const schools = Array.isArray(schoolEntries) ? schoolEntries : [];
  const failures = Array.isArray(failureList) ? failureList : [];
  const queueTop = schools
    .map(([schoolId]) => {
      const schoolInfo = getSchoolInfo(data, schoolId);
      return {
        schoolId,
        schoolName: schoolInfo.schoolName || schoolId,
        queueLen: Number(data.schoolQueues?.[schoolId] || 0)
      };
    })
    .sort((a, b) => b.queueLen - a.queueLen)[0];
  const failureTypeStats = failures.reduce((acc, item) => {
    const key = (item?.failureType || "unknown").toString();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topFailure = Object.entries(failureTypeStats).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0];
  const filterTags = [
    filters.schoolId ? `学校 ${filters.schoolId}` : "学校 全部",
    filters.systemType ? `教务类型 ${formatSystemType(filters.systemType)}` : "教务类型 全部",
    filters.failureType ? `失败类型 ${formatFailureType(filters.failureType)}` : "失败类型 全部"
  ];
  const headline = `当前筛选覆盖 ${formatCount(schools.length)} 所学校，命中 ${formatCount(failures.length)} 条失败记录`;
  const sublineParts = [
    queueTop ? `排队最高：${queueTop.schoolName} ${formatCount(queueTop.queueLen)} 条` : "暂无排队学校",
    topFailure ? `高频失败：${formatFailureType(topFailure[0])} ${formatCount(topFailure[1])} 条` : "暂无失败高频项",
    `指标刷新：${formatTime(data.latestMetricsAt)}`
  ];
  dashboardSummaryPanel.innerHTML = `
    <div class="overview-banner-main">
      <div class="overview-banner-title">${escapeHtml(headline)}</div>
      <div class="overview-banner-sub">${escapeHtml(sublineParts.join(" | "))}</div>
    </div>
    <div class="overview-banner-tags">
      ${filterTags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
    </div>
  `;
}
function getScriptPendingStatus(item, stage) {
  if (item?.pendingAvailable) {
    return {
      label: "有待发布版本",
      tone: "warning",
      sub: "可执行全量发布或灰度发布"
    };
  }
  if (stage === "pending") {
    return {
      label: "待发布已过期",
      tone: "danger",
      sub: "元信息仍指向 pending，但候选脚本内容已不存在"
    };
  }
  return {
    label: "无待发布版本",
    tone: "",
    sub: "等待新的候选脚本进入 pending"
  };
}
function getScriptRollbackStatus(item, parentVersion) {
  if (parentVersion > 0 && item?.rollbackAvailable) {
    return {
      label: `可回滚到 v${parentVersion}`,
      tone: "warning",
      sub: "父版本备份存在，可直接回滚"
    };
  }
  if (parentVersion > 0) {
    return {
      label: `缺失 v${parentVersion} 备份`,
      tone: "danger",
      sub: "元信息记录了父版本，但备份内容已缺失或过期"
    };
  }
  return {
    label: "暂无回滚目标",
    tone: "",
    sub: "当前脚本没有可回退的父版本"
  };
}
// 脚本发布页顶部说明用于明确“待发布 -> 灰度/全量 -> 回滚”的操作路径，以及当前最需要关注的异常点。
function renderScriptReleaseGuide(list) {
  if (!scriptReleaseGuide || !scriptReleaseMeta) return;
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeScriptListItem(item));
  const stageCount = { active: 0, canary: 0, pending: 0, rollback: 0, unknown: 0 };
  let pendingExpired = 0;
  let rollbackMissing = 0;
  let failureFocus = null;
  for (const item of items) {
    const stage = (item?.meta?.releaseStage || "unknown").toString();
    stageCount[stage] = (stageCount[stage] || 0) + 1;
    if (stage === "pending" && !item?.pendingAvailable) pendingExpired += 1;
    if (Number(item?.meta?.parentVersion || 0) > 0 && !item?.rollbackAvailable) rollbackMissing += 1;
    if (!failureFocus || Number(item?.recentFailureCount || 0) > Number(failureFocus?.recentFailureCount || 0)) {
      failureFocus = item;
    }
  }
  const title = `发布路径：候选脚本先进入待发布，再选择灰度发布或全量发布；回滚依赖父版本备份`;
  const sub = [
    `当前生效 ${formatCount(stageCount.active || 0)} 个`,
    `灰度发布 ${formatCount(stageCount.canary || 0)} 个`,
    `待发布 ${formatCount(stageCount.pending || 0)} 个`,
    failureFocus && Number(failureFocus?.recentFailureCount || 0) > 0
      ? `失败关注 ${failureFocus.scriptName} ${formatCount(failureFocus.recentFailureCount)} 条`
      : "最近无高频失败脚本"
  ];
  scriptReleaseGuide.innerHTML = `
    <div class="overview-banner-main">
      <div class="overview-banner-title">${escapeHtml(title)}</div>
      <div class="overview-banner-sub">${escapeHtml(sub.join(" | "))}</div>
    </div>
    <div class="overview-banner-tags">
      <span class="badge warning">待发布过期 ${escapeHtml(formatCount(pendingExpired))}</span>
      <span class="badge danger">缺失回滚备份 ${escapeHtml(formatCount(rollbackMissing))}</span>
      <span class="badge">查看详情可切换历史事件与脚本内容</span>
    </div>
  `;
  scriptReleaseMeta.textContent = `共 ${formatCount(items.length)} 个脚本。优先处理“待发布已过期”与“缺失回滚备份”的脚本，再决定灰度或全量发布。`;
}
function renderRuntimeLogSummary(payload) {
  if (!runtimeLogSummaryCards || !runtimeLogCallout) return;
  const info = normalizeRuntimeLogPayload(payload, runtimeLogSource?.value || "all", runtimeLogLimit?.value || 500);
  const source = info.source;
  const lines = info.lines;
  const counts = info.counts;
  const missingSources = info.missingSources;
  const files = info.files;
  const countEntries = Object.entries(counts || {}).filter(([, count]) => Number(count || 0) > 0);
  const cards = [
    {
      title: "当前来源",
      value: formatRuntimeLogSourceName(source),
      sub: source === "all" ? "合并展示多份日志尾部片段" : "仅展示所选来源的日志尾部"
    },
    {
      title: "实际加载",
      value: `${formatCount(lines.length)} 行`,
      sub: `读取上限 ${formatCount(info.requestedLimit || runtimeLogLimit?.value || 500)} 行`
    },
    {
      title: "有内容来源",
      value: formatCount(countEntries.length),
      sub: countEntries.length
        ? countEntries.map(([name, count]) => `${formatRuntimeLogSourceTag(name)} ${formatCount(count)}`).join(" | ")
        : "当前没有来源返回内容"
    },
    {
      title: "缺失来源",
      value: formatCount((missingSources || []).length),
      sub: missingSources.length
        ? missingSources.map((item) => formatRuntimeLogSourceName(item)).join(" | ")
        : "未发现缺失文件"
    }
  ];
  runtimeLogSummaryCards.innerHTML = cards
    .map(
      (card, index) => `
        <div class="card ${index === 0 ? "primary" : ""}">
          <h3>${escapeHtml(card.title)}</h3>
          <div class="value">${escapeHtml(card.value)}</div>
          <div class="sub">${escapeHtml(card.sub)}</div>
        </div>
      `
    )
    .join("");
  const isMissing = missingSources.length > 0;
  const isEmpty = !lines.length;
  const tone = isMissing ? "warning" : isEmpty ? "danger" : "success";
  const explanation =
    source === "all"
      ? "“全部来源”会把 llm-backend、nginx 与后台缓存的尾部片段直接拼接展示，便于快速总览，但不会按真实时间重新排序。"
      : `当前只读取 ${formatRuntimeLogSourceName(source)} 的日志尾部，适合定位单一来源问题。`;
  const fileParts = Object.entries(files || {})
    .map(([key, value]) => `${formatRuntimeLogSourceTag(key)}：${value || "-"}`)
    .join(" | ");
  const detailParts = (info.sourceDetails || [])
    .map((item) => {
      const label = item?.label || formatRuntimeLogSourceName(item?.key || "");
      const count = formatCount(item?.lineCount || 0);
      const missing = item?.missing ? "缺失" : "可读";
      return `${label} ${count} 行（${missing}）`;
    })
    .join(" | ");
  const missingText = missingSources.length
    ? `缺失来源：${missingSources.map((item) => formatRuntimeLogSourceName(item)).join("、")}。`
    : "所有配置的来源文件均可访问。";
  runtimeLogCallout.className = `info-callout ${tone}`.trim();
  runtimeLogCallout.innerHTML = `
    <div class="info-callout-title">读取说明</div>
    <div class="info-callout-body">${escapeHtml(explanation)}</div>
    <div class="info-callout-body">${escapeHtml(missingText)}</div>
    <div class="info-callout-body">${escapeHtml(`读取时间：${formatTime(info.loadedAt || 0)} | 请求来源：${formatRuntimeLogSourceName(info.requestedSource)}`)}</div>
    <div class="info-callout-body">${escapeHtml(`来源明细：${detailParts || "暂无明细"}`)}</div>
    <div class="info-callout-body">${escapeHtml(`来源文件：${fileParts}`)}</div>
  `;
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
      title: "客户端上报解析成功",
      value: formatCount(appParseSummary.successCount),
      sub: `上报总数 ${formatCount(appParseSummary.totalCount)}`,
      tone: "primary"
    },
    {
      title: "客户端上报解析失败",
      value: formatCount(appParseSummary.failureCount),
      sub: `成功率 ${appParseSummary.totalCount > 0 ? ((appParseSummary.successCount / appParseSummary.totalCount) * 100).toFixed(1) : "0.0"}%`,
      tone: "warning"
    },
    {
      title: "客户端脚本拉取次数",
      value: formatCount(pullTotal),
      sub: `云端 ${formatCount(pullFromCloud)} | 本地 ${formatCount(pullFromLocal)}`,
      tone: "primary"
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
          <div class="card ${card.tone || ""}">
            <h3>${card.title}</h3>
            <div class="value">${card.value}</div>
            <div class="sub">${card.sub}</div>
          </div>
        `
    )
    .join("");
}

function renderSchools(data, filters, schoolEntries) {
  const filtered = Array.isArray(schoolEntries) ? schoolEntries : getFilteredSchoolEntries(data, filters);
  if (schoolTableMeta) {
    schoolTableMeta.textContent = filtered.length
      ? `共 ${formatCount(filtered.length)} 所学校，按最近更新时间排序；解析列显示“成功 / 失败 / 空结果”，便于快速判断质量。`
      : "当前筛选下暂无学校统计。";
  }
  schoolTableBody.innerHTML = filtered
    .map(([schoolId, info]) => {
      const queueLen = data.schoolQueues?.[schoolId] ?? 0;
      const rate = calcSuccessRate(info.parse_success, info.parse_failed, info.parse_empty);
      const badgeClass = rate >= 0.8 ? "success" : rate >= 0.5 ? "warning" : "danger";
      const schoolInfo = getSchoolInfo(data, schoolId);
      const parseTotal = Number(info.parse_success || 0) + Number(info.parse_failed || 0) + Number(info.parse_empty || 0);
      return `
            <tr>
              <td>${buildInfoLine(schoolId, queueLen > 0 ? `待处理 ${formatCount(queueLen)} 条` : "当前队列为空")}</td>
              <td>${buildInfoLine(schoolInfo.schoolName || "-", schoolInfo.schoolName ? "学校展示名称" : "尚未识别学校名称")}</td>
              <td>${buildInfoLine(formatSystemType(schoolInfo.schoolSystemType), "当前归类的教务系统")}</td>
              <td>${buildInfoLine(formatSourceType(schoolInfo.systemSource), "系统来源")}</td>
              <td>${buildBadgeLine(formatCount(queueLen), queueLen > 0 ? "warning" : "", queueLen > 0 ? "排队处理中" : "无待处理任务")}</td>
              <td>${buildBadgeLine(`${(rate * 100).toFixed(1)}%`, badgeClass, `解析总数 ${formatCount(parseTotal)}`)}</td>
              <td>${buildInfoLine(`${info.parse_success} / ${info.parse_failed} / ${info.parse_empty}`, "成功 / 失败 / 空结果")}</td>
              <td>${buildInfoLine(`${info.summary_success} / ${info.summary_failed}`, "总结成功 / 失败")}</td>
              <td>${buildInfoLine(`${info.script_success} / ${info.script_failed}`, "脚本成功 / 失败")}</td>
              <td>${buildInfoLine(formatCost(info.costTotal), "累计模型费用")}</td>
              <td>${buildInfoLine(formatTime(info.lastUpdatedAt), "最近指标更新时间")}</td>
            </tr>
          `;
    })
    .join("");
  if (!filtered.length) {
    schoolTableBody.innerHTML = `<tr><td colspan="11" class="muted">暂无数据</td></tr>`;
  }
}

function renderFailures(data, filters, failureItems) {
  const list = Array.isArray(failureItems) ? failureItems : getFilteredFailureItems(data, filters);
  if (failureTableMeta) {
    failureTableMeta.textContent = list.length
      ? `共 ${formatCount(list.length)} 条失败记录，按发生时间倒序排列；原因列优先保留最关键的运维上下文。`
      : "当前筛选下暂无失败记录。";
  }
  failureTableBody.innerHTML = list
    .map((item) => {
      const schoolId = item.schoolId || "";
      const schoolInfo = getSchoolInfo(data, schoolId);
      const schoolLabel = schoolInfo.schoolName || schoolId || "-";
      return `
          <tr>
            <td>${buildInfoLine(schoolLabel, `${schoolId || "-"} | ${formatSystemType(schoolInfo.schoolSystemType || "unknown")}`)}</td>
            <td>${buildInfoLine(item.scriptName || "-", "关联脚本")}</td>
            <td>${buildBadgeLine(formatFailureType(item.failureType), "danger", item.failureType || "unknown")}</td>
            <td>${buildInfoLine(item.reason || "-", "失败原因摘要")}</td>
            <td>${buildInfoLine(formatTime(item.createdAt), "最近失败时间")}</td>
          </tr>
        `;
    })
    .join("");
  if (!list.length) {
    failureTableBody.innerHTML = `<tr><td colspan="5" class="muted">暂无失败记录</td></tr>`;
  }
  renderFailureSummary(list);
  return list;
}

function renderPullScriptStats(data) {
  if (!pullScriptTableBody) return;
  const list = Array.isArray(data?.scriptPullStats?.scriptStats) ? [...data.scriptPullStats.scriptStats] : [];
  list.sort((a, b) => Number(b?.total || 0) - Number(a?.total || 0) || Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  if (pullScriptTableMeta) {
    const totalPull = list.reduce((sum, item) => sum + Number(item?.total || 0), 0);
    const totalUnique = list.reduce((sum, item) => sum + Number(item?.uniqueTotal || 0), 0);
    pullScriptTableMeta.textContent = list.length
      ? `共 ${formatCount(list.length)} 个脚本，累计拉取 ${formatCount(totalPull)} 次；“任务去重”表示同一任务去重后的有效拉取数 ${formatCount(totalUnique)}。`
      : "暂无客户端脚本拉取统计。";
  }
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
          <td>${buildInfoLine(item?.scriptName || "-", item?.category || "未分类")}</td>
          <td>${buildInfoLine(item?.category || "-", "脚本分类")}</td>
          <td>${buildInfoLine(formatCount(total), `去重后 ${formatCount(uniqueTotal)}`)}</td>
          <td>${buildInfoLine(formatCount(fromCloud), `去重后 ${formatCount(uniqueFromCloud)}`)}</td>
          <td>${buildInfoLine(formatCount(fromLocal), `去重后 ${formatCount(uniqueFromLocal)}`)}</td>
          <td>${buildInfoLine(formatCount(uniqueTotal), "同任务去重后的总拉取")}</td>
          <td>${buildInfoLine(formatCount(uniqueFromCloud), "去重后云端拉取")}</td>
          <td>${buildInfoLine(formatCount(uniqueFromLocal), "去重后本地拉取")}</td>
          <td>${buildBadgeLine(`${cloudRate}%`, Number(cloudRate) >= 70 ? "warning" : "success", "云端占全部拉取的比例")}</td>
          <td>${buildInfoLine(formatTime(item?.updatedAt || 0), "最近统计更新时间")}</td>
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

async function fetchWithAuth(requestPath, init = {}) {
  const token = getToken();
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${token}`
  };
  const res = await fetch(requestPath, {
    ...init,
    headers
  });
  if (res.status === 401) {
    throw new Error("unauthorized");
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `unexpected_response_${res.status}`);
  }
  if (!res.ok) {
    throw new Error(parsed?.msg || `http_${res.status}`);
  }
  return parsed;
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
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `unexpected_response_${res.status}`);
  }
  if (!res.ok) {
    throw new Error(parsed?.msg || `http_${res.status}`);
  }
  return parsed;
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return `${value ?? ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRepairLogSearchKeywords(query) {
  return `${query ?? ""}`
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function highlightRepairLogText(value, query) {
  const keywords = parseRepairLogSearchKeywords(query);
  const raw = `${value ?? ""}`;
  if (!keywords.length || !raw) {
    return escapeHtml(raw);
  }
  const escaped = escapeHtml(raw);
  return keywords.reduce((acc, keyword) => {
    const pattern = new RegExp(escapeRegExp(keyword), "gi");
    return acc.replace(pattern, (match) => `<mark class="log-highlight">${match}</mark>`);
  }, escaped);
}

function renderUsersTable(list) {
  if (!userTableBody) return;
  const items = Array.isArray(list) ? list : [];
  if (userStats) {
    const onlineCount = items.filter((item) => Number(item?.lastLoginAt || 0) > 0).length;
    userStats.innerHTML = `
      <span class="badge">总账号 ${items.length}</span>
      <span class="badge success">有登录记录 ${onlineCount}</span>
      <span class="badge warning">首次可使用默认账号 admin/admin</span>
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
    return true;
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return false;
    }
    showToast("error", "加载用户失败", e?.message || "网络错误");
    return false;
  }
}

async function createUser() {
  const username = (newUserNameInput?.value || "").trim();
  const password = (newUserPasswordInput?.value || "").trim();
  if (!username || !password) {
    showToast("warning", "参数不足", "请输入账号和密码");
    return;
  }
  const confirmed = await askOperationConfirm({
    title: "确认新增账号",
    detail: `将创建账号 ${username}，创建后可立即用于登录运维后台。`,
    emphasizeText: "请确认该账号仅分配给对应运维人员使用。",
    confirmLabel: "确认新增",
    danger: false,
    kicker: "账号变更确认"
  });
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
  if (!runtimeLogContent) return false;
  const source = (runtimeLogSource?.value || "all").toString();
  const limit = Math.max(100, Math.min(20000, Number(runtimeLogLimit?.value || 500)));
  runtimeLogContent.textContent = "日志加载中...";
  if (runtimeLogMeta) runtimeLogMeta.textContent = "正在读取日志来源与结果说明…";
  if (runtimeLogSummaryCards) runtimeLogSummaryCards.innerHTML = "";
  if (runtimeLogCallout) {
    runtimeLogCallout.className = "info-callout";
    runtimeLogCallout.textContent = "正在生成日志摘要…";
  }
  try {
    // 运行日志页除了展示正文，还会额外输出“读取到了什么 / 缺了什么 / 当前结果意味着什么”的摘要层。
    const qs = new URLSearchParams();
    qs.set("source", source);
    qs.set("limit", String(limit));
    const result = await fetchWithAuth(`/api/v1/admin/runtime_logs?${qs.toString()}`);
    if (!result || Number(result.code) !== 200) {
      throw new Error(result?.msg || "日志接口不可用");
    }
    const payload = normalizeRuntimeLogPayload(result.data, source, limit);
    const files = payload.files || {};
    const lines = payload.lines || [];
    const counts = payload.counts || {};
    const missingSources = payload.missingSources || [];
    renderRuntimeLogSummary(payload);
    if (runtimeLogMeta) {
      const countText = `后端 ${counts.backend ?? "-"} | nginx访问 ${counts.nginx_access ?? "-"} | nginx错误 ${
        counts.nginx_error ?? "-"
      } | 后台缓存 ${counts.admin ?? "-"}`;
      const missingText = missingSources.length
        ? `\n缺失来源：${missingSources.map((item) => formatRuntimeLogSourceName(item)).join("、")}`
        : "";
      runtimeLogMeta.textContent = `当前来源：${formatRuntimeLogSourceName(payload.source)} | 实际显示 ${formatCount(
        payload.lineCount || lines.length
      )} 行 | 请求 ${formatCount(payload.requestedLimit || limit)} 行 | 刷新时间 ${formatTime(
        payload.loadedAt || Date.now()
      )}\n来源统计：${countText}\n后端文件：${files.backend || "-"} | nginx访问文件：${files.nginx_access || "-"} | nginx错误文件：${
        files.nginx_error || "-"
      } | 后台缓存：${files.admin || "-"}${missingText}`;
    }
    runtimeLogSnapshot = {
      source: payload.source,
      lines,
      loadedAt: payload.loadedAt || Date.now()
    };
    runtimeLogContent.textContent = lines.length
      ? lines.join("\n")
      : `当前来源“${formatRuntimeLogSourceName(source)}”暂无可读日志。\n请检查对应服务是否已产生输出，或确认日志文件路径是否存在。`;
    if (runtimeLogAutoScroll?.checked) {
      runtimeLogContent.scrollTop = runtimeLogContent.scrollHeight;
    }
    return true;
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return false;
    }
    runtimeLogContent.textContent = "日志加载失败";
    if (runtimeLogMeta) runtimeLogMeta.textContent = "日志读取失败，请检查接口与服务端文件路径。";
    if (runtimeLogCallout) {
      runtimeLogCallout.className = "info-callout danger";
      runtimeLogCallout.textContent = `日志加载失败：${e?.message || "网络错误"}`;
    }
    showToast("error", "加载日志失败", e?.message || "网络错误");
    return false;
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
  return true;
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
          <div class="card ${card.title === "成功率" ? "primary" : ""}">
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
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeScriptListItem(item));
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
    { title: "脚本总数", value: formatCount(items.length), sub: "当前脚本输出目录中的脚本数", tone: "primary" },
    { title: "当前生效", value: formatCount(countByStage.active), sub: "已全量生效", tone: "primary" },
    { title: "灰度发布", value: formatCount(countByStage.canary), sub: "正在逐步放量", tone: "" },
    { title: "待发布", value: formatCount(countByStage.pending), sub: `过期 ${formatCount(pendingMissing)} 个`, tone: "warning" },
    { title: "回滚不可用", value: formatCount(rollbackMissing), sub: "父版本备份缺失或过期", tone: "warning" }
  ];
  scriptSummaryCards.innerHTML = cards
    .map(
      (card) => `
          <div class="card ${card.tone || ""}">
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
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeScriptListItem(item));
  scriptTableBody.innerHTML = items
    .map((item) => {
      const meta = item.meta || {};
      const stage = meta.releaseStage || "unknown";
      const v = Number(meta.version || 0);
      const pv = Number(meta.parentVersion || 0);
      const failCount = Number(item.recentFailureCount || 0);
      const failBadge =
        failCount > 0 ? `<span class="badge danger" style="margin-left:8px">失败 ${failCount}</span>` : "";
      const pendingStatus = getScriptPendingStatus(item, stage);
      const rollbackStatus = getScriptRollbackStatus(item, pv);
      const pendingBadge = `<span class="badge ${pendingStatus.tone || ""}">${escapeHtml(pendingStatus.label)}</span>`;
      const rollbackBadge = `<span class="badge ${rollbackStatus.tone || ""}">${escapeHtml(rollbackStatus.label)}</span>`;
      const promoteDisabled = item.pendingAvailable ? "" : "disabled";
      const rollbackDisabled = item.rollbackAvailable ? "" : "disabled";
      return `
        <tr>
          <td>
            <div class="cell-inline-head">
              <span class="cell-main">${escapeHtml(item.scriptName || "-")}</span>
              ${failBadge}
            </div>
            <div class="cell-sub">当前阶段：${escapeHtml(formatReleaseStageText(stage))}</div>
          </td>
          <td>${stageBadge(stage)}<div class="cell-sub">线上状态标签</div></td>
          <td>${buildInfoLine(`v${v}`, "当前脚本版本")}</td>
          <td>${buildInfoLine(pv > 0 ? `v${pv}` : "-", pv > 0 ? "回滚目标父版本" : "尚未形成父版本")}</td>
          <td>${pendingBadge}<div class="cell-sub">${escapeHtml(pendingStatus.sub)}</div></td>
          <td>${rollbackBadge}<div class="cell-sub">${escapeHtml(rollbackStatus.sub)}</div></td>
          <td>${buildInfoLine(formatTime(meta.updatedAt), "最近更新时间")}</td>
          <td>${buildInfoLine(meta.appliedBy || "-", "最近操作人")}</td>
          <td>
            <div class="actions">
              <button class="btn secondary" type="button" data-action="view" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" data-pv="${pv}">查看详情</button>
              <button class="btn" type="button" data-action="promote-active" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${promoteDisabled}>发布全量</button>
              <button class="btn secondary" type="button" data-action="promote-gradual" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${promoteDisabled}>灰度发布</button>
              <button class="btn secondary" type="button" data-action="rollback" data-script="${encodeURIComponent(
                item.scriptName || ""
              )}" ${rollbackDisabled}>回滚到上一版</button>
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
    const list = (scriptResult.data?.list || []).map((item) => normalizeScriptListItem(item));
    scriptsCache = list;
    renderScriptCards(list);
    renderScriptReleaseGuide(list);
    renderScriptsTable(list);
    return true;
  } catch (e) {
    if (e?.message === "unauthorized") {
      clearToken();
      overlay.style.display = "flex";
      closeAdminEvents();
      return false;
    }
    showToast("error", "加载脚本列表失败", e?.message || "网络错误");
    return false;
  }
}

async function promoteWithDoubleConfirm(scriptName, pushMode) {
  const modeLabel = pushMode === "canary" ? "灰度发布" : "全量发布";
  const confirmed = await askOperationConfirm({
    title: `确认${modeLabel}`,
    detail: `${modeLabel}将更新脚本 ${scriptName} 的线上流量指向，请确认发布窗口、候选验证结果与回滚路径均已检查。`,
    emphasizeText: "脚本发布属于高风险操作，确认后会立即触发生效流程。",
    confirmText: scriptName,
    confirmLabel: `确认${modeLabel}`,
    danger: true,
    kicker: "发布确认"
  });
  if (!confirmed) {
    showToast("warning", "已取消", `${modeLabel}已取消`);
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
      const modeLabel = pushMode === "canary" ? "灰度发布" : "全量发布";
      try {
        await withButtonLoading(btn, "发布中...", async () => {
          const json = await promoteWithDoubleConfirm(scriptName, pushMode);
          if (json?.aborted) return;
          if (json.code === 200) {
            showToast("info", "发布成功", `${scriptName} -> ${modeLabel}`);
            await loadScriptsPage();
            return;
          }
          showToast("error", "发布失败", json.msg || "未知错误");
        });
      } catch (err) {
        showToast("error", "发布失败", err?.message || "网络错误");
      }
      return;
    }
    if (action === "rollback") {
      try {
        await withButtonLoading(btn, "回滚中...", async () => {
          const confirmed = await askOperationConfirm({
            title: "确认回滚脚本",
            detail: `将把脚本 ${scriptName} 回滚到上一版本，并立即影响后续脚本下发。`,
            emphasizeText: "请确认父版本备份可用，并已评估当前线上脚本的回退影响。",
            confirmText: scriptName,
            confirmLabel: "确认回滚",
            danger: true,
            kicker: "回滚确认"
          });
          if (!confirmed) {
            showToast("warning", "已取消", "未执行回滚操作");
            return;
          }
          const json = await postWithAuth("/api/v1/admin/rollback_script", { scriptName });
          if (json.code === 200) {
            showToast("warning", "已回滚", `${scriptName} 已回滚到上个版本`);
            await loadScriptsPage();
            return;
          }
          showToast("error", "回滚失败", json.msg || "未知错误");
        });
      } catch (err) {
        showToast("error", "回滚失败", err?.message || "网络错误");
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
  const filteredSchools = getFilteredSchoolEntries(currentData, filters);
  const filteredFailures = getFilteredFailureItems(currentData, filters);
  renderDashboardSummary(currentData, filteredSchools, filteredFailures, filters);
  renderSchools(currentData, filters, filteredSchools);
  renderFailures(currentData, filters, filteredFailures);
  renderPullScriptStats(currentData);
}

async function loadRepairIssuesPage(options = {}) {
  if (!repairIssueTableBody) return false;
  const silent = options?.silent === true;
  const preserveSelection = options?.preserveSelection !== false;
  if (!silent) {
    repairIssueMeta.textContent = "加载中...";
    if (!repairIssuesListCache.length) {
      repairIssueTableBody.innerHTML = `<tr><td colspan="11" class="muted">加载中...</td></tr>`;
    }
  }
  try {
    const result = await fetchWithAuth("/api/v1/admin/repair/issues");
    const list = (Array.isArray(result.data?.list) ? result.data.list : []).map((item) => normalizeRepairIssueRecord(item));
    repairIssuesListCache = list;
    repairIssueMeta.textContent = buildRepairIssueListMeta(list);
    renderRepairIssuesTable(list);
    if (preserveSelection && activeRepairIssueId && !list.some((item) => item?.issueId === activeRepairIssueId)) {
      resetRepairIssueDetail("当前修复问题已不存在、已过期或已被删除。");
    }
    return true;
  } catch (e) {
    if (!silent) {
      repairIssueMeta.textContent = "加载失败";
      repairIssueTableBody.innerHTML = `<tr><td colspan="11" class="muted">加载失败：${escapeHtml(e?.message || "")}</td></tr>`;
    }
    return false;
  }
}

function buildRepairIssueListMeta(list) {
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeRepairIssueRecord(item));
  const byStatus = items.reduce((acc, item) => {
    const key = (item?.status || "open").toString();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byStatus)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([status, count]) => `${getRepairStatusLabel(status)} ${count}`)
    .join(" | ");
  return `共 ${items.length} 条 | ${summary || "暂无状态分布"} | 最后刷新 ${formatTime(Date.now())}`;
}

function buildRepairStateBadges(issue) {
  const info = issue || {};
  const badges = [
    `<span class="badge ${getRepairStatusTone(info.status)}">${escapeHtml(getRepairStatusLabel(info.status))}</span>`,
    `<span class="badge">${escapeHtml(formatRepairOperationalStageLabel(info.currentStage) || info.currentStage || "-")}</span>`
  ];
  if ((info.lastReplayStatus || "").toString()) {
    badges.push(
      `<span class="badge ${info.lastReplayStatus === "success" ? "success" : "danger"}">复现 ${
        info.lastReplayStatus === "success" ? "通过" : "失败"
      }</span>`
    );
  }
  if ((info.lastCandidateStatus || "").toString()) {
    badges.push(
      `<span class="badge ${info.lastCandidateStatus === "success" ? "success" : "danger"}">候选验证 ${
        info.lastCandidateStatus === "success" ? "通过" : "失败"
      }</span>`
    );
  }
  return badges.join(" ");
}

function renderRepairIssuesTable(list) {
  if (!repairIssueTableBody) return;
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeRepairIssueRecord(item));
  if (!items.length) {
    repairIssueTableBody.innerHTML = `<tr><td colspan="11" class="muted">暂无修复问题</td></tr>`;
    return;
  }
  repairIssueTableBody.innerHTML = items
    .map((item) => {
      const issueId = (item?.issueId || "").toString();
      const selectedClass = issueId && issueId === activeRepairIssueId ? "selected-row" : "";
      const errorText = (item?.lastErrorMessage || "").toString().trim();
      const sourceText = item.lastScriptSource ? `脚本来源 ${formatScriptSourceLabel(item.lastScriptSource)}` : "脚本来源未知";
      const contextText = [item.lastStatusCode ? `HTTP ${item.lastStatusCode}` : "", item.lastErrorCode ? `错误码 ${item.lastErrorCode}` : "", item.lastDurationMs ? `${item.lastDurationMs}ms` : ""]
        .filter(Boolean)
        .join(" | ");
      return `
        <tr class="${selectedClass}" data-issue-row="${encodeURIComponent(issueId)}">
          <td>${escapeHtml(issueId)}</td>
          <td>
            <div class="log-main-text">${escapeHtml(item.schoolName || item.schoolId || "-")}</div>
            <div class="log-sub-text">${escapeHtml(item.schoolId || "-")}</div>
          </td>
          <td>${escapeHtml(formatSystemType(item.schoolSystemType || "unknown"))}</td>
          <td>
            <div class="log-main-text">${escapeHtml(item.affectedScriptId || "-")}</div>
            <div class="log-sub-text">v${escapeHtml(item.affectedVersion || 0)} | ${escapeHtml(sourceText)}</div>
          </td>
          <td>${escapeHtml(item.affectedVersion || 0)}</td>
          <td>
            <div class="log-main-text">${escapeHtml(formatFailureType(item.failureType || "unknown"))}</div>
            <div class="log-sub-text">${escapeHtml(errorText || contextText || "暂无最近错误")}</div>
          </td>
          <td>${escapeHtml(item.sampleCount || 0)}</td>
          <td>${escapeHtml(item.userCount || 0)}</td>
          <td>${buildRepairStateBadges(item)}</td>
          <td>
            <div class="log-main-text">${escapeHtml(formatTime(item.lastSeenAt || item.updatedAt))}</div>
            <div class="log-sub-text">最近步骤 ${escapeHtml(formatTime(item.lastStepAt || item.updatedAt || 0))}</div>
          </td>
          <td>
            <button class="btn secondary compact" type="button" data-action="detail" data-issue="${encodeURIComponent(issueId)}">详情</button>
            <button class="btn secondary compact" type="button" data-action="row-menu" data-issue="${encodeURIComponent(
              issueId
            )}">更多操作</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function formatRepairIssueMeta(issue) {
  const info = normalizeRepairIssueRecord(issue);
  return [
    `问题编号：${info.issueId || "-"}`,
    `状态：${getRepairStatusLabel(info.status || "open")}`,
    `当前阶段：${formatRepairOperationalStageLabel(info.currentStage) || info.currentStage || "-"}`,
    `学校：${info.schoolName || info.schoolId || "-"}`,
    `脚本：${info.affectedScriptId || "-"} / v${Number(info.affectedVersion || 0)}`,
    `最近步骤：${formatTime(info.lastStepAt || info.updatedAt || 0)}`,
    `最近出现：${formatTime(info.lastSeenAt || info.updatedAt || 0)}`,
    `最近错误：${info.lastErrorMessage || "-"}`,
    `最近解析器：${info.lastParserName ? `${info.lastParserName} / v${Number(info.lastParserVersion || 0)}` : "-"}`,
    `脚本来源：${formatScriptSourceLabel(info.lastScriptSource || "")}`,
    `样本数：${Number(info.sampleCount || 0)}`,
    `影响用户：${Number(info.userCount || 0)}`
  ].join(" | ");
}

function formatRepairStageLabel(stage) {
  const key = (stage || "").toString().trim();
  const item = REPAIR_STAGE_FLOW.find((it) => it.stage === key);
  return item ? `${item.label}（${item.stage}）` : key || "-";
}

function formatRepairSourceLabel(source) {
  const key = (source || "").toString().trim();
  const map = {
    parse_report: "客户端失败上报",
    parse_task: "云端兜底解析",
    school_queue: "修复队列",
    queue_processor: "自动修复流程",
    admin_retry: "管理员重试",
    admin_force_repair: "管理员立即修复",
    admin_replay: "管理员复现"
  };
  return map[key] || key || "-";
}

function formatRepairModelRoleLabel(role) {
  const key = (role || "").toString().trim();
  if (key === "summary") return "模型 1";
  if (key === "script_repair") return "模型 2";
  return "";
}

function formatRepairLlmStageLabel(stage) {
  const key = (stage || "").toString().trim();
  const map = {
    summary: "总结阶段",
    patch_guidance: "修复指令阶段",
    script_generation: "脚本生成阶段"
  };
  return map[key] || key;
}

function formatRepairActionLabel(action) {
  const key = (action || "").toString().trim();
  const map = {
    summarize_submissions: "模型1总结中",
    summarize_submissions_single: "模型1逐条总结中",
    generate_patch_guidance: "模型1指令生成中",
    generate_patch_guidance_single: "模型1逐条指令生成中",
    generate_candidate_script: "模型2修复中",
    generate_candidate_script_single: "模型2逐条修复中",
    replay_candidate_script: "候选脚本验证中",
    replay_candidate_script_single: "逐条候选脚本验证中"
  };
  return map[key] || key;
}

function formatRepairHighLevelActionLabel(action) {
  const key = (action || "").toString().trim();
  const map = {
    summarize_submissions: "模型1处理中",
    summarize_submissions_single: "模型1处理中",
    generate_patch_guidance: "模型1处理中",
    generate_patch_guidance_single: "模型1处理中",
    generate_candidate_script: "模型2修复中",
    generate_candidate_script_single: "模型2修复中",
    replay_candidate_script: "候选脚本验证中",
    replay_candidate_script_single: "候选脚本验证中"
  };
  return map[key] || "";
}

function formatRepairOperationalStageLabel(stage) {
  const key = (stage || "").toString().trim();
  const map = {
    REPORT_RECEIVED: "收到失败上报",
    ISSUE_MERGED: "已归并到修复问题",
    QUEUED: "排队等待修复",
    REPLAY_RUNNING: "问题复现中",
    REPLAY_RESULT: "问题复现结果",
    CANDIDATE_TEST_RUNNING: "自动修复处理中",
    CANDIDATE_TEST_RESULT: "自动修复结果",
    PENDING_RELEASE: "待人工发布",
    PUBLISHED: "已发布",
    ROLLED_BACK: "已回滚",
    DISABLED: "已禁用"
  };
  return map[key] || "";
}

function buildRepairContextItem(label, value) {
  return `<div class="repair-context-item"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(
    value ?? "-"
  )}</div></div>`;
}

function buildRepairContextFromMeta(meta) {
  const info = normalizeRepairTraceMeta(meta);
  const parts = [];
  const llmStageText = info.llmStageLabel || formatRepairLlmStageLabel(info.llmStage || "");
  if (info.provider || info.model) parts.push([info.provider, info.model].filter(Boolean).join(" / "));
  if (llmStageText) parts.push(`阶段 ${llmStageText}`);
  if (info.scriptName) parts.push(`脚本 ${info.scriptName}`);
  if (Number(info.previousVersion || 0) > 0) parts.push(`基于 v${Number(info.previousVersion || 0)}`);
  if (Number(info.sampleCount || 0) > 0) parts.push(`样本 ${Number(info.sampleCount || 0)}`);
  if (Number(info.includedSamples || 0) > 0) parts.push(`纳入 ${Number(info.includedSamples || 0)} 条`);
  if (Number(info.droppedSamples || 0) > 0) parts.push(`跳过 ${Number(info.droppedSamples || 0)} 条`);
  if (Number(info.truncatedSamples || 0) > 0) parts.push(`截断 ${Number(info.truncatedSamples || 0)} 条`);
  if (Number(info.inputChars || 0) > 0) parts.push(`输入 ${Number(info.inputChars || 0)} 字`);
  if (Number(info.originalInputChars || 0) > Number(info.inputChars || 0)) {
    parts.push(`原始 ${Number(info.originalInputChars || 0)} 字`);
  }
  if (Number(info.summaryChars || 0) > 0) parts.push(`总结 ${Number(info.summaryChars || 0)} 字`);
  if (Number(info.guidanceChars || 0) > 0) parts.push(`指令 ${Number(info.guidanceChars || 0)} 字`);
  if (Number(info.previousScriptChars || 0) > 0) parts.push(`旧脚本 ${Number(info.previousScriptChars || 0)} 字`);
  if (info.previousScriptExtracted) parts.push("旧脚本已提炼");
  if ((info.scriptRepairMode || "").toString().trim()) parts.push(`修复模式 ${String(info.scriptRepairMode).trim()}`);
  if (info.cacheHit) parts.push("缓存命中");
  if (info.opsApplied || Number(info.opsCount || 0) > 0) parts.push(`操作 ${Number(info.opsCount || 0)} 项`);
  if (Number(info.opsMissedCount || 0) > 0) parts.push(`未命中 ${Number(info.opsMissedCount || 0)} 项`);
  if ((info.opsApplyFailureReason || "").toString().trim()) parts.push(`ops失败 ${String(info.opsApplyFailureReason).trim()}`);
  if (info.truncatedSummary || info.truncatedGuidance || info.truncatedPreviousScript) {
    parts.push(
      `已裁剪 ${[
        info.truncatedSummary ? "总结" : "",
        info.truncatedGuidance ? "指令" : "",
        info.truncatedPreviousScript ? "旧脚本" : ""
      ]
        .filter(Boolean)
        .join("/")}`
    );
  }
  if ((info.inputClipStrategy || "").toString().trim()) parts.push(`输入策略 ${String(info.inputClipStrategy).trim()}`);
  if ((info.summaryClipStrategy || "").toString().trim()) parts.push(`总结裁剪 ${String(info.summaryClipStrategy).trim()}`);
  if ((info.guidanceClipStrategy || "").toString().trim()) parts.push(`指令裁剪 ${String(info.guidanceClipStrategy).trim()}`);
  if ((info.previousScriptClipStrategy || "").toString().trim()) {
    parts.push(`旧脚本裁剪 ${String(info.previousScriptClipStrategy).trim()}`);
  }
  if (Number(info.timeoutBudgetMs || 0) > 0) parts.push(`超时 ${Number(info.timeoutBudgetMs || 0)}ms`);
  if (Number(info.attemptsUsed || 0) > 0 || Number(info.maxAttempts || 0) > 0) {
    parts.push(`尝试 ${Number(info.attemptsUsed || 0)}/${Number(info.maxAttempts || 0) || 1}`);
  }
  if (Number(info.retryCount || 0) > 0) parts.push(`重试 ${Number(info.retryCount || 0)} 次`);
  if ((info.retryPolicy || "").toString().trim()) parts.push(`重试策略 ${String(info.retryPolicy).trim()}`);
  if (Number(info.repairRound || 0) > 1) parts.push(`修复第 ${Number(info.repairRound || 0)} 轮`);
  if ((info.failureType || "").toString().trim()) parts.push(`失败类型 ${String(info.failureType).trim()}`);
  if (Number(info.statusCode || 0) > 0) parts.push(`HTTP ${Number(info.statusCode || 0)}`);
  if ((info.errorCode || "").toString().trim()) parts.push(`错误码 ${String(info.errorCode).trim()}`);
  if (Number(info.latencyMs || 0) > 0) parts.push(`耗时 ${Number(info.latencyMs || 0)}ms`);
  if (Number(info.lastAttemptLatencyMs || 0) > 0) parts.push(`末次 ${Number(info.lastAttemptLatencyMs || 0)}ms`);
  if ((info.fallbackPath || "").toString().trim()) parts.push(`降级 ${String(info.fallbackPath).trim()}`);
  if ((info.manualSuggestion || "").toString().trim()) parts.push(`人工建议 ${String(info.manualSuggestion).trim()}`);
  if ((info.releaseStage || "").toString().trim()) parts.push(`发布阶段 ${String(info.releaseStage).trim()}`);
  return parts.join(" · ");
}

function buildRepairTraceContext(meta) {
  const info = normalizeRepairTraceMeta(meta);
  const parts = [];
  const modelRole = formatRepairModelRoleLabel(info.modelRole);
  const llmStageText = info.llmStageLabel || formatRepairLlmStageLabel(info.llmStage || "");
  const modelText = [info.provider, info.model].filter(Boolean).join(" / ");
  if (modelRole) parts.push(modelRole);
  if (llmStageText) parts.push(llmStageText);
  if (modelText) parts.push(modelText);
  if (info.scriptName) parts.push(`脚本 ${info.scriptName}`);
  if (Number(info.previousVersion || 0) > 0) parts.push(`基于 v${Number(info.previousVersion || 0)}`);
  if (Number(info.sampleCount || 0) > 0) parts.push(`样本 ${Number(info.sampleCount || 0)}`);
  if (Number(info.includedSamples || 0) > 0) parts.push(`纳入 ${Number(info.includedSamples || 0)} 条`);
  if (Number(info.droppedSamples || 0) > 0) parts.push(`跳过 ${Number(info.droppedSamples || 0)} 条`);
  if (Number(info.truncatedSamples || 0) > 0) parts.push(`截断 ${Number(info.truncatedSamples || 0)} 条`);
  if (Number(info.inputChars || 0) > 0) parts.push(`输入 ${Number(info.inputChars || 0)} 字`);
  if (Number(info.originalInputChars || 0) > Number(info.inputChars || 0)) {
    parts.push(`原始 ${Number(info.originalInputChars || 0)} 字`);
  }
  if (Number(info.summaryChars || 0) > 0) parts.push(`总结 ${Number(info.summaryChars || 0)} 字`);
  if (Number(info.guidanceChars || 0) > 0) parts.push(`指令 ${Number(info.guidanceChars || 0)} 字`);
  if (Number(info.previousScriptChars || 0) > 0) parts.push(`旧脚本 ${Number(info.previousScriptChars || 0)} 字`);
  if (info.previousScriptExtracted) parts.push("旧脚本已提炼");
  if ((info.scriptRepairMode || "").toString().trim()) parts.push(`修复模式 ${String(info.scriptRepairMode).trim()}`);
  if (info.cacheHit) parts.push("缓存命中");
  if (info.opsApplied || Number(info.opsCount || 0) > 0) parts.push(`操作 ${Number(info.opsCount || 0)} 项`);
  if (Number(info.opsMissedCount || 0) > 0) parts.push(`未命中 ${Number(info.opsMissedCount || 0)} 项`);
  if ((info.opsApplyFailureReason || "").toString().trim()) parts.push(`ops失败 ${String(info.opsApplyFailureReason).trim()}`);
  if (info.truncatedSummary || info.truncatedGuidance || info.truncatedPreviousScript) {
    parts.push(
      `已裁剪 ${[
        info.truncatedSummary ? "总结" : "",
        info.truncatedGuidance ? "指令" : "",
        info.truncatedPreviousScript ? "旧脚本" : ""
      ]
        .filter(Boolean)
        .join("/")}`
    );
  }
  if ((info.inputClipStrategy || "").toString().trim()) parts.push(`输入策略 ${String(info.inputClipStrategy).trim()}`);
  if ((info.summaryClipStrategy || "").toString().trim()) parts.push(`总结裁剪 ${String(info.summaryClipStrategy).trim()}`);
  if ((info.guidanceClipStrategy || "").toString().trim()) parts.push(`指令裁剪 ${String(info.guidanceClipStrategy).trim()}`);
  if ((info.previousScriptClipStrategy || "").toString().trim()) {
    parts.push(`旧脚本裁剪 ${String(info.previousScriptClipStrategy).trim()}`);
  }
  if ((info.contextStrategy || "").toString().trim()) parts.push(`策略 ${String(info.contextStrategy).trim()}`);
  if (Number(info.timeoutBudgetMs || 0) > 0) parts.push(`超时 ${Number(info.timeoutBudgetMs || 0)}ms`);
  if (Number(info.attemptsUsed || 0) > 0 || Number(info.maxAttempts || 0) > 0) {
    parts.push(`尝试 ${Number(info.attemptsUsed || 0)}/${Number(info.maxAttempts || 0) || 1}`);
  }
  if (Number(info.retryCount || 0) > 0) parts.push(`重试 ${Number(info.retryCount || 0)} 次`);
  if ((info.retryPolicy || "").toString().trim()) parts.push(`重试策略 ${String(info.retryPolicy).trim()}`);
  if (Number(info.repairRound || 0) > 1) parts.push(`修复第 ${Number(info.repairRound || 0)} 轮`);
  if ((info.failureType || "").toString().trim()) parts.push(`失败类型 ${String(info.failureType).trim()}`);
  if (Number(info.statusCode || 0) > 0) parts.push(`HTTP ${Number(info.statusCode || 0)}`);
  if ((info.errorCode || "").toString().trim()) parts.push(`错误码 ${String(info.errorCode).trim()}`);
  if (Number(info.latencyMs || 0) > 0) parts.push(`耗时 ${Number(info.latencyMs || 0)}ms`);
  if (Number(info.lastAttemptLatencyMs || 0) > 0) parts.push(`末次 ${Number(info.lastAttemptLatencyMs || 0)}ms`);
  if ((info.fallbackPath || "").toString().trim()) parts.push(`降级 ${String(info.fallbackPath).trim()}`);
  if ((info.manualSuggestion || "").toString().trim()) parts.push(`人工建议 ${String(info.manualSuggestion).trim()}`);
  return parts.join(" · ");
}

function buildRepairTraceDisplay(item) {
  const entry = normalizeRepairTraceEntry(item);
  const message = (entry?.message || "").toString().trim();
  const actionTitle = formatRepairActionLabel(entry?.meta?.action || "");
  const stageTitle = formatRepairOperationalStageLabel(entry?.stage || "");
  const sourceLabel = formatRepairSourceLabel(entry?.source || "");
  const context = buildRepairTraceContext(entry?.meta || {});
  const title =
    entry?.level === "error" && message
      ? message
      : actionTitle || stageTitle || message || formatRepairStageLabel(entry?.stage || "");
  return {
    title,
    subtitle: [sourceLabel, context, message && message !== title ? message : ""].filter(Boolean).join(" · ")
  };
}

function getLatestRepairEntry(list, matcher) {
  const items = Array.isArray(list) ? list : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (matcher(item)) {
      return item;
    }
  }
  return null;
}

function buildRepairStatusSnapshot(name, entry, fallbackText) {
  if (!entry) {
    return {
      name,
      tone: "",
      badgeText: "未开始",
      detail: fallbackText || "暂无记录",
      meta: ""
    };
  }
  const meta = entry?.meta || {};
  const display = buildRepairTraceDisplay(entry);
  let tone = "";
  let badgeText = "已完成";
  if (entry?.level === "error") {
    tone = "danger";
    badgeText = "失败";
  } else if (entry?.level === "warning") {
    tone = "warning";
    badgeText = "警告";
  } else if ((entry?.stage || "").toString() === "PENDING_RELEASE") {
    tone = "warning";
    badgeText = "待发布";
  } else if ((entry?.stage || "").toString() === "PUBLISHED") {
    tone = "success";
    badgeText = "已发布";
  } else if ((entry?.stage || "").toString() === "ROLLED_BACK") {
    tone = "warning";
    badgeText = "已回滚";
  } else if ((entry?.stage || "").toString() === "DISABLED") {
    tone = "danger";
    badgeText = "已禁用";
  } else if (["CANDIDATE_TEST_RUNNING", "REPLAY_RUNNING"].includes((entry?.stage || "").toString())) {
    badgeText = "进行中";
  } else if (meta?.ok === true) {
    tone = "success";
    badgeText = "成功";
  }
  return {
    name,
    tone,
    badgeText,
    detail: display.title || fallbackText || "暂无记录",
    meta: [buildRepairContextFromMeta(meta), `更新时间 ${formatTime(entry?.ts || 0)}`].filter(Boolean).join(" | ")
  };
}

function collectRepairModelSnapshots(issue, timelineItems, logItems) {
  const combined = []
    .concat((Array.isArray(timelineItems) ? timelineItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .concat((Array.isArray(logItems) ? logItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  const currentStage = (issue?.currentStage || "").toString();
  const summaryEntry = getLatestRepairEntry(combined, (item) => item?.meta?.modelRole === "summary");
  const scriptEntry = getLatestRepairEntry(combined, (item) => item?.meta?.modelRole === "script_repair");
  const rawVerifyEntry = getLatestRepairEntry(
    combined,
    (item) =>
      ["replay_candidate_script", "replay_candidate_script_single"].includes((item?.meta?.action || "").toString()) ||
      ((item?.stage || "").toString() === "CANDIDATE_TEST_RESULT" && /回放/.test((item?.message || "").toString()))
  );
  const verifyEntry =
    rawVerifyEntry && scriptEntry && Number(rawVerifyEntry?.ts || 0) < Number(scriptEntry?.ts || 0)
      ? null
      : rawVerifyEntry;
  const releaseEntry = getLatestRepairEntry(
    combined,
    (item) => ["PENDING_RELEASE", "PUBLISHED", "ROLLED_BACK", "DISABLED"].includes((item?.stage || "").toString())
  );
  const summaryFallback =
    getRepairStageIndex(currentStage) >= getRepairStageIndex("CANDIDATE_TEST_RUNNING")
      ? "已进入自动修复阶段，等待模型 1 记录。"
      : "问题尚未进入模型 1 汇总阶段。";
  const scriptFallback =
    getRepairStageIndex(currentStage) >= getRepairStageIndex("CANDIDATE_TEST_RUNNING")
      ? "等待模型 2 生成候选脚本。"
      : "模型 2 尚未启动。";
  const verifyFallback =
    getRepairStageIndex(currentStage) >= getRepairStageIndex("CANDIDATE_TEST_RESULT")
      ? "等待回放验证记录。"
      : "候选脚本验证尚未开始。";
  const releaseFallback = REPAIR_FINAL_STAGES.has(currentStage)
    ? "当前问题已结束，等待查看最终发布结果。"
    : "候选脚本尚未进入待发布或正式发布阶段。";
  return [
    buildRepairStatusSnapshot("模型 1：总结与修复指令", summaryEntry, summaryFallback),
    buildRepairStatusSnapshot("模型 2：候选脚本生成", scriptEntry, scriptFallback),
    buildRepairStatusSnapshot("候选验证：提交样本回放", verifyEntry, verifyFallback),
    buildRepairStatusSnapshot("发布状态：Pending / Publish / Rollback", releaseEntry, releaseFallback)
  ];
}

function collectRepairCurrentStepSnapshot(issue, timelineItems, logItems) {
  const combined = []
    .concat((Array.isArray(timelineItems) ? timelineItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .concat((Array.isArray(logItems) ? logItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  const currentStage = (issue?.currentStage || "").toString();
  const entry =
    getLatestRepairEntry(combined, (item) => (item?.stage || "").toString() === currentStage) ||
    combined[combined.length - 1] ||
    null;
  const stageLabel = entry?.stage ? formatRepairStageLabel(entry.stage) : formatRepairStageLabel(currentStage);
  const name = `当前步骤：${stageLabel || currentStage || "-"}`;
  return buildRepairStatusSnapshot(name, entry, "暂无步骤记录");
}

function collectRepairFailureInsights(issue, timelineItems, logItems) {
  const issueInfo = normalizeRepairIssueRecord(issue);
  const list = [];
  const seen = new Set();
  const pushFailure = (title, meta, tone = "danger") => {
    const normalizedTitle = (title || "").toString().trim();
    if (!normalizedTitle || seen.has(normalizedTitle)) return;
    seen.add(normalizedTitle);
    list.push({ title: normalizedTitle, meta: (meta || "").toString(), tone });
  };
  if ((issueInfo?.lastErrorMessage || "").toString().trim()) {
    pushFailure(
      `最近失败：${issueInfo.lastErrorMessage}`,
      [
        `阶段 ${formatRepairOperationalStageLabel(issueInfo?.currentStage) || issueInfo?.currentStage || "-"}`,
        `状态 ${getRepairStatusLabel(issueInfo?.status || "open")}`,
        `最近步骤 ${formatTime(issueInfo?.lastStepAt || issueInfo?.updatedAt || 0)}`
      ].join(" | ")
    );
  }
  const combined = []
    .concat((Array.isArray(logItems) ? logItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .concat((Array.isArray(timelineItems) ? timelineItems : []).map((item) => normalizeRepairTraceEntry(item)))
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  combined.forEach((item) => {
    if (list.length >= 3) return;
    const level = (item?.level || "").toString();
    if (level !== "error" && level !== "warning") return;
    const display = buildRepairTraceDisplay(item);
    const meta = item?.meta || {};
    pushFailure(
      display.title || item?.message || "未知失败",
      [
        `${formatRepairStageLabel(item?.stage || "-")} / ${formatRepairSourceLabel(item?.source || "-")}`,
        buildRepairContextFromMeta(meta),
        `时间 ${formatTime(item?.ts || 0)}`
      ]
        .filter(Boolean)
        .join(" | "),
      level === "warning" ? "warning" : "danger"
    );
  });
  if (!list.length) {
    list.push({
      title: "当前没有失败记录",
      meta: "最近日志中未发现 error / warning 级别事件。",
      tone: "success"
    });
  }
  return list;
}

function renderRepairOverview(detail, timelineItems, logItems) {
  if (!repairIssueOverviewGrid) return;
  const issue = normalizeRepairIssueRecord(detail?.issue || {});
  const modelSnapshots = collectRepairModelSnapshots(issue, timelineItems, logItems);
  const currentStepSnapshot = collectRepairCurrentStepSnapshot(issue, timelineItems, logItems);
  const failureItems = collectRepairFailureInsights(issue, timelineItems, logItems);
  const overviewTags = buildRepairStateBadges(issue);
  const contextHtml = [
    ["学校", issue.schoolName || issue.schoolId || "-"],
    ["教务系统", formatSystemType(issue.schoolSystemType || "unknown")],
    ["脚本", issue.affectedScriptId || "-"],
    ["脚本版本", `v${Number(issue.affectedVersion || 0)}`],
    ["失败类型", formatFailureType(issue.failureType || "unknown")],
    ["来源主机", issue.sourceUrlHost || "-"],
    ["最近解析器", issue.lastParserName ? `${issue.lastParserName} / v${Number(issue.lastParserVersion || 0)}` : "-"],
    ["脚本来源", formatScriptSourceLabel(issue.lastScriptSource || "")],
    ["状态码 / 错误码", [issue.lastStatusCode ? `HTTP ${issue.lastStatusCode}` : "", issue.lastErrorCode || ""].filter(Boolean).join(" / ") || "-"],
    ["最近耗时", issue.lastDurationMs ? `${issue.lastDurationMs}ms` : "-"],
    ["最近结果", issue.lastResultCount ? `${issue.lastResultCount} 条` : issue.lastSchemaValid === false ? "结构校验失败" : "-"],
    ["样本数", Number(issue.sampleCount || 0)],
    ["影响用户", Number(issue.userCount || 0)],
    ["最近出现", formatTime(issue.lastSeenAt || issue.updatedAt || 0)],
    ["最近步骤", formatTime(issue.lastStepAt || issue.updatedAt || 0)],
    [
      "问题复现",
      issue.lastReplayStatus ? (issue.lastReplayStatus === "success" ? "最近通过" : "最近失败") : "暂无结果"
    ],
    [
      "候选验证",
      issue.lastCandidateStatus ? (issue.lastCandidateStatus === "success" ? "最近通过" : "最近失败") : "暂无结果"
    ]
  ]
    .map(([label, value]) => buildRepairContextItem(label, value))
    .join("");
  const modelHtml = [currentStepSnapshot].concat(modelSnapshots).filter(Boolean).map(
      (item) => `
        <div class="repair-model-status-item ${item.tone}">
          <div class="repair-model-status-head">
            <div class="repair-model-status-name">${escapeHtml(item.name)}</div>
            <span class="badge ${item.tone}">${escapeHtml(item.badgeText)}</span>
          </div>
          <div class="repair-model-status-detail">${escapeHtml(item.detail)}</div>
          <div class="repair-model-status-meta">${escapeHtml(item.meta || "暂无补充信息")}</div>
        </div>
      `
    ).join("");
  const failureHtml = failureItems
    .map(
      (item) => `
        <div class="repair-failure-item ${item.tone === "warning" ? "warning" : ""}">
          <div class="repair-failure-title">${escapeHtml(item.title)}</div>
          <div class="repair-failure-meta">${escapeHtml(item.meta || "-")}</div>
        </div>
      `
    )
    .join("");
  repairIssueOverviewGrid.innerHTML = `
    <div class="card repair-summary-card">
      <div class="repair-summary-title">
        <h4>问题概览</h4>
        <span class="badge">${escapeHtml(issue.priority || "P2")}</span>
      </div>
      <div class="repair-summary-main">${escapeHtml(
        issue.issueId ? `当前处理问题：${issue.issueId}` : "选择修复问题后展示上下文。"
      )}</div>
      <div class="repair-summary-tags">${overviewTags}</div>
      <div class="repair-context-grid">${contextHtml}</div>
    </div>
    <div class="card repair-summary-card">
      <h4>模型与发布状态</h4>
      <div class="repair-model-status-list">${modelHtml}</div>
    </div>
    <div class="card repair-summary-card">
      <h4>失败原因</h4>
      <div class="repair-failure-list">${failureHtml}</div>
    </div>
  `;
}

function resolveCurrentOperationalTitle(stage, currentEntry) {
  const actionTitle = formatRepairHighLevelActionLabel(currentEntry?.meta?.action || "");
  if (actionTitle) {
    return actionTitle;
  }
  return formatRepairOperationalStageLabel(stage || "") || stage || "-";
}

function getRepairStageIndex(stage) {
  const key = (stage || "").toString().trim();
  return REPAIR_STAGE_FLOW.findIndex((it) => it.stage === key);
}

function buildMetricPill(label, value) {
  return `<span class="metric-pill"><span class="label">${escapeHtml(label)}</span><span>${escapeHtml(
    value ?? "-"
  )}</span></span>`;
}

function getFilteredRepairLogs(list, query) {
  const keywords = parseRepairLogSearchKeywords(query);
  const items = Array.isArray(list) ? list : [];
  if (!keywords.length) return items;
  return items.filter((item) => {
    const message = (item?.message || "").toString().toLowerCase();
    const stage = (item?.stage || "").toString().toLowerCase();
    const source = (item?.source || "").toString().toLowerCase();
    const actor = (item?.actor || "").toString().toLowerCase();
    const title = buildRepairTraceDisplay(item).title.toLowerCase();
    const subtitle = buildRepairTraceDisplay(item).subtitle.toLowerCase();
    const meta = item?.meta ? JSON.stringify(item.meta).toLowerCase() : "";
    const haystack = [message, stage, source, actor, title, subtitle, meta].join(" ");
    return keywords.every((keyword) => haystack.includes(keyword));
  });
}

function buildRepairLogsText(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const display = buildRepairTraceDisplay(item);
      const meta = item?.meta ? ` | meta=${JSON.stringify(item.meta)}` : "";
      return `[${formatTime(item?.ts || 0)}] [${item?.level || "info"}] ${item?.stage || "-"} | ${
        item?.source || "-"
      } | ${item?.actor || "-"} | ${Number(item?.durationMs || 0)}ms | ${display.title || "-"}${
        display.subtitle ? ` | ${display.subtitle}` : ""
      }${meta}`;
    })
    .join("\n");
}

function buildRepairIssueSummaryText(detail, timelineItems, logItems) {
  const issue = detail?.issue || {};
  if (!issue?.issueId) return "";
  const modelSnapshots = collectRepairModelSnapshots(issue, timelineItems, logItems);
  const failureItems = collectRepairFailureInsights(issue, timelineItems, logItems);
  const timelineLines = (Array.isArray(timelineItems) ? timelineItems : [])
    .slice(-8)
    .map((item) => {
      const display = buildRepairTraceDisplay(item);
      return `- ${formatTime(item?.ts || 0)} | ${formatRepairStageLabel(item?.stage || "-")} | ${display.title || "-"}`;
    })
    .join("\n");
  const modelLines = modelSnapshots
    .map((item) => `- ${item.name}：${item.badgeText} | ${item.detail}${item.meta ? ` | ${item.meta}` : ""}`)
    .join("\n");
  const failureLines = failureItems.map((item) => `- ${item.title}${item.meta ? ` | ${item.meta}` : ""}`).join("\n");
  return [
    "【修复问题摘要】",
    formatRepairIssueMeta(issue),
    "",
    "【模型与发布状态】",
    modelLines || "- 暂无记录",
    "",
    "【失败原因】",
    failureLines || "- 暂无失败记录",
    "",
    "【最近时间线】",
    timelineLines || "- 暂无时间线"
  ].join("\n");
}

function updateRepairLogSummary(totalCount, filteredCount, query) {
  if (!repairIssueLogSummary) return;
  const stage = repairIssueLogStage?.value || "";
  const level = repairIssueLogLevel?.value || "";
  const queryText = `${query || ""}`.trim();
  repairIssueLogSummary.textContent = [
    `日志总数 ${totalCount}`,
    `当前显示 ${filteredCount}`,
    `阶段 ${stage ? formatRepairStageLabel(stage) : "全部阶段"}`,
    `级别 ${level || "全部级别"}`,
    `搜索 ${queryText || "未设置"}`,
    `自动刷新 ${repairIssueAutoRefresh?.checked ? "开启" : "关闭"}`,
    `自动滚动 ${repairIssueFollowLogs?.checked ? "开启" : "关闭"}`
  ].join(" | ");
}

function renderRepairProgress(issue, timelineItems) {
  if (!repairIssueProgressSteps || !repairIssueProgressMetrics || !repairIssueProgressStageBadge) return;
  const info = normalizeRepairIssueRecord(issue);
  const stage = (info.currentStage || "").toString();
  const stageIndex = getRepairStageIndex(stage);
  const normalizedStageIndex = stageIndex >= 0 ? stageIndex : 0;
  const lastStepAt = Number(info.lastStepAt || info.updatedAt || 0);
  const lastSeenAt = Number(info.lastSeenAt || info.updatedAt || 0);

  const timelineList = (Array.isArray(timelineItems) ? timelineItems : []).map((item) => normalizeRepairTraceEntry(item));
  const stageTimeMap = new Map();
  const stageEntryMap = new Map();
  for (const item of timelineList) {
    const key = (item?.stage || "").toString();
    const ts = Number(item?.ts || 0);
    if (!key || !ts) continue;
    const existing = stageTimeMap.get(key) || 0;
    if (ts > existing) {
      stageTimeMap.set(key, ts);
      stageEntryMap.set(key, item);
    }
  }

  const firstTs = timelineList.reduce((min, item) => {
    const ts = Number(item?.ts || 0);
    if (!ts) return min;
    return min === 0 ? ts : Math.min(min, ts);
  }, 0);
  const lastTs = timelineList.reduce((max, item) => Math.max(max, Number(item?.ts || 0)), 0);
  const durationText = firstTs && lastTs ? formatDuration(lastTs - firstTs) : "-";

  const statusText = `${formatRepairOperationalStageLabel(info.currentStage || "") || info.currentStage || "-"} · ${
    info.status || "open"
  }`;
  repairIssueProgressStageBadge.textContent = statusText;
  repairIssueProgressStageBadge.classList.remove("success", "warning", "danger");
  if (["PUBLISHED"].includes(info.currentStage)) {
    repairIssueProgressStageBadge.classList.add("success");
  } else if (["ROLLED_BACK", "DISABLED"].includes(info.currentStage)) {
    repairIssueProgressStageBadge.classList.add("warning");
  } else if (info.lastErrorMessage) {
    repairIssueProgressStageBadge.classList.add("danger");
  }

  if (repairIssueProgressHint) {
    const percent = Math.round(((normalizedStageIndex + 1) / REPAIR_STAGE_FLOW.length) * 100);
    const currentEntry =
      stageEntryMap.get(stage) || timelineList[timelineList.length - 1] || null;
    const currentDisplay = buildRepairTraceDisplay(currentEntry);
    const operationalTitle = resolveCurrentOperationalTitle(stage, currentEntry);
    repairIssueProgressStageBadge.textContent = `${operationalTitle} · ${info.status || "open"}`;
    repairIssueProgressHint.textContent = currentDisplay.title
      ? `进度 ${percent}% · 修复耗时 ${durationText} · 当前动作：${currentDisplay.title}`
      : `进度 ${percent}% · 修复耗时 ${durationText}`;
  }

  repairIssueProgressMetrics.innerHTML = [
    buildMetricPill("样本", Number(info.sampleCount || 0)),
    buildMetricPill("影响用户", Number(info.userCount || 0)),
    buildMetricPill("最近出现", formatTime(lastSeenAt)),
    buildMetricPill("最近步骤", formatTime(lastStepAt)),
    buildMetricPill("当前状态", getRepairStatusLabel(info.status || "open")),
    buildMetricPill("最近错误", info.lastErrorMessage ? "有" : "无")
  ].join("");

  repairIssueProgressSteps.innerHTML = REPAIR_STAGE_FLOW.map((step, idx) => {
    const ts = stageTimeMap.get(step.stage) || 0;
    const meta = ts ? formatTime(ts) : "未发生";
    const classes = ["progress-step"];
    if (idx < normalizedStageIndex) classes.push("completed");
    if (idx === normalizedStageIndex) classes.push("active");
    if (idx === normalizedStageIndex && info.lastErrorMessage) classes.push("failed");
    const statusText =
      idx < normalizedStageIndex
        ? "已完成"
        : idx === normalizedStageIndex
          ? info.lastErrorMessage
            ? "失败"
            : ["CANDIDATE_TEST_RUNNING", "REPLAY_RUNNING"].includes((step.stage || "").toString())
              ? "进行中"
              : "当前"
          : "待执行";
    return `
      <div class="${classes.join(" ")}" data-stage="${escapeHtml(step.stage)}">
        <div class="dot"></div>
        <div class="content">
          <div class="stage">${escapeHtml(step.label)}</div>
          <div class="meta">${escapeHtml(step.stage)} · ${escapeHtml(meta)}</div>
          <div class="detail">${escapeHtml(statusText)}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderRepairTimelineList(list) {
  if (!repairIssueTimelineList) return;
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeRepairTraceEntry(item));
  if (!items.length) {
    repairIssueTimelineList.innerHTML = `<div class="muted">暂无时间线</div>`;
    return;
  }
  repairIssueTimelineList.innerHTML = items
    .map((item) => {
      const ts = formatTime(item?.ts || 0);
      const stage = (item?.stage || "").toString();
      const display = buildRepairTraceDisplay(item);
      const selectedStage = (repairIssueLogStage?.value || "").toString();
      const activeClass = selectedStage ? (selectedStage === stage ? "active" : "") : activeRepairIssueId && repairIssueDetailCache?.issue?.currentStage === stage ? "active" : "";
      return `
        <div class="timeline-item ${activeClass}" data-stage="${escapeHtml(stage)}">
          <div class="timeline-side">
            <div class="timeline-time">${escapeHtml(ts)}</div>
            <div class="timeline-stage">${escapeHtml(formatRepairStageLabel(stage || "-"))}</div>
            <div class="timeline-raw-stage">${escapeHtml(stage || "-")}</div>
          </div>
          <div class="timeline-main">
            <div class="timeline-message">${escapeHtml(display.title || "-")}</div>
            <div class="timeline-source">${escapeHtml(display.subtitle || "-")}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderRepairTimeline(list) {
  if (!repairIssueTimeline) return;
  const items = (Array.isArray(list) ? list : []).map((item) => normalizeRepairTraceEntry(item));
  if (!items.length) {
    repairIssueTimeline.textContent = "暂无时间线";
    return;
  }
  renderRepairTimelineList(items);
  repairIssueTimeline.textContent = items
    .map((item) => {
      const ts = formatTime(item?.ts || 0);
      const stage = (item?.stage || "").toString();
      const msg = (item?.message || "").toString();
      const source = (item?.source || "").toString();
      return `[${ts}] ${stage} | ${source || "-"} | ${msg || "-"}`;
    })
    .join("\n");
}

function renderRepairLogsTable(list) {
  if (!repairIssueLogTable) return;
  const wrapEnabled = repairIssueLogWrap?.checked !== false;
  const query = (repairIssueLogSearch?.value || "").toString();
  const sourceList = (Array.isArray(list) ? list : []).map((item) => normalizeRepairTraceEntry(item));
  const filtered = getFilteredRepairLogs(sourceList, query);
  const previousScrollTop = repairIssueLogTable.scrollTop;
  if (!filtered.length) {
    repairIssueLogTable.innerHTML = `<div class="muted" style="padding: 12px 14px;">暂无日志</div>`;
    updateRepairLogSummary(sourceList.length, 0, query);
    return filtered;
  }
  const rows = filtered
    .map((item) => {
      const ts = formatTime(item?.ts || 0);
      const stage = (item?.stage || "").toString();
      const stageLabel = formatRepairStageLabel(stage);
      const level = (item?.level || "info").toString();
      const source = (item?.source || "").toString();
      const actor = (item?.actor || "").toString();
      const durationMs = Number(item?.durationMs || 0);
      const display = buildRepairTraceDisplay(item);
      const meta = item?.meta ? JSON.stringify(item.meta, null, 2) : "";
      const levelClass = level === "error" ? "danger" : level === "warning" ? "warning" : "";
      const metaHtml = meta
        ? `<details><summary class="muted">meta</summary><pre class="repair-log-meta">${highlightRepairLogText(meta, query)}</pre></details>`
        : "";
      return `
        <tr class="log-row">
          <td class="log-col-time">${highlightRepairLogText(ts, query)}</td>
          <td class="log-col-level"><span class="badge ${levelClass}">${escapeHtml(level)}</span></td>
          <td class="log-col-stage">
            <div class="log-main-text">${highlightRepairLogText(stageLabel, query)}</div>
            <div class="log-sub-text">${highlightRepairLogText(stage, query)}</div>
          </td>
          <td class="log-col-source">
            <div class="log-main-text">${highlightRepairLogText(formatRepairSourceLabel(source || "-"), query)}</div>
            <div class="log-sub-text">${highlightRepairLogText(source || "-", query)}</div>
          </td>
          <td class="log-col-actor">
            <div class="log-main-text">${highlightRepairLogText(actor || "-", query)}</div>
            <div class="log-sub-text">${escapeHtml(durationMs)}ms</div>
          </td>
          <td class="log-col-message">
            <div class="log-msg ${wrapEnabled ? "" : "nowrap"}">${highlightRepairLogText(display.title || "-", query)}</div>
            <div class="log-sub-text log-context">${highlightRepairLogText(display.subtitle || "", query)}</div>
            ${metaHtml}
          </td>
        </tr>
      `;
    })
    .join("");
  repairIssueLogTable.innerHTML = `
    <table class="repair-log-table">
      <colgroup>
        <col class="log-col-time">
        <col class="log-col-level">
        <col class="log-col-stage">
        <col class="log-col-source">
        <col class="log-col-actor">
        <col class="log-col-message">
      </colgroup>
      <thead>
        <tr>
          <th class="log-col-time">时间</th>
          <th class="log-col-level">级别</th>
          <th class="log-col-stage">阶段</th>
          <th class="log-col-source">来源</th>
          <th class="log-col-actor">操作者/耗时</th>
          <th class="log-col-message">内容</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
  updateRepairLogSummary(sourceList.length, filtered.length, query);
  if (repairIssueFollowLogs?.checked) {
    repairIssueLogTable.scrollTop = repairIssueLogTable.scrollHeight;
  } else {
    repairIssueLogTable.scrollTop = previousScrollTop;
  }
  return filtered;
}

function renderRepairLogs(data) {
  if (!repairIssueDetail) return;
  const list = (Array.isArray(data?.list) ? data.list : []).map((item) => normalizeRepairTraceEntry(item));
  if (!list.length) {
    repairIssueDetail.textContent = "暂无日志";
    updateRepairLogSummary(0, 0, repairIssueLogSearch?.value || "");
    return;
  }
  const filtered = renderRepairLogsTable(list);
  repairIssueDetail.textContent = buildRepairLogsText(filtered);
}

function resetRepairIssueDetail(message = "选择一条修复问题后查看详情。") {
  activeRepairIssueId = "";
  repairIssueDetailCache = null;
  repairIssueTimelineCache = [];
  repairIssueLogsCache = [];
  if (repairIssueSelected) repairIssueSelected.value = "";
  if (repairIssueDetailMeta) repairIssueDetailMeta.textContent = message;
  if (repairIssueLogSearch) repairIssueLogSearch.value = "";
  if (repairIssueTimelineList) repairIssueTimelineList.innerHTML = `<div class="muted">暂无时间线</div>`;
  if (repairIssueTimeline) {
    repairIssueTimeline.textContent = "暂无时间线";
    repairIssueTimeline.classList.remove("hidden");
  }
  if (repairIssueDetail) {
    repairIssueDetail.textContent = "选择一条修复问题后查看日志。";
    repairIssueDetail.classList.remove("hidden");
  }
  if (repairIssueLogSummary) {
    repairIssueLogSummary.textContent = "选择修复问题后展示当前筛选结果、自动刷新与自动滚动状态。";
  }
  if (repairIssueLogTable) repairIssueLogTable.innerHTML = "";
  if (repairIssueProgressStageBadge) repairIssueProgressStageBadge.textContent = "-";
  if (repairIssueProgressHint) repairIssueProgressHint.textContent = "选择修复问题后展示处理进度";
  if (repairIssueProgressMetrics) repairIssueProgressMetrics.innerHTML = "";
  if (repairIssueProgressSteps) repairIssueProgressSteps.innerHTML = "";
  if (repairIssueOverviewGrid) {
    repairIssueOverviewGrid.innerHTML = `
      <div class="card repair-summary-card">
        <h4>问题概览</h4>
        <div class="muted">选择修复问题后展示学校、脚本版本、失败类型与来源等上下文。</div>
      </div>
      <div class="card repair-summary-card">
        <h4>模型与发布状态</h4>
        <div class="muted">这里会展示模型 1、模型 2、候选验证和待发布状态。</div>
      </div>
      <div class="card repair-summary-card">
        <h4>失败原因</h4>
        <div class="muted">这里会展示最近失败原因、状态码、错误码与耗时信息。</div>
      </div>
    `;
  }
  renderRepairIssuesTable(repairIssuesListCache);
}

function renderRepairIssueDetailPanels() {
  const detail = repairIssueDetailCache || {};
  const issue = detail.issue ? normalizeRepairIssueRecord(detail.issue) : null;
  if (!issue) {
    resetRepairIssueDetail();
    return;
  }
  if (repairIssueDetailMeta) {
    repairIssueDetailMeta.textContent = formatRepairIssueMeta(issue);
  }
  renderRepairOverview(detail, repairIssueTimelineCache, repairIssueLogsCache);
  renderRepairProgress(issue, repairIssueTimelineCache);
  renderRepairTimeline(repairIssueTimelineCache);
  renderRepairLogs({ list: repairIssueLogsCache });
  if (repairIssueDetail && repairIssueLogTable) {
    repairIssueDetail.classList.add("hidden");
  }
  if (repairIssueTimeline && repairIssueTimelineList) {
    repairIssueTimeline.classList.add("hidden");
  }
  renderRepairIssuesTable(repairIssuesListCache);
}

async function loadRepairIssueTimeline(issueId) {
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/timeline?limit=200`);
  if (result.code !== 200) {
    throw new Error(result.msg || "时间线加载失败");
  }
  const list = (Array.isArray(result?.data?.list) ? result.data.list : []).map((item) => normalizeRepairTraceEntry(item));
  repairIssueTimelineCache = list;
  renderRepairIssueDetailPanels();
  return list;
}

async function loadRepairIssueLogs(issueId) {
  const params = new URLSearchParams();
  params.set("limit", "200");
  const stage = repairIssueLogStage?.value || "";
  const level = repairIssueLogLevel?.value || "";
  if (stage) params.set("stage", stage);
  if (level) params.set("level", level);
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/logs?${params.toString()}`);
  if (result.code !== 200) {
    throw new Error(result.msg || "日志加载失败");
  }
  const data = result?.data || {};
  const list = (Array.isArray(data?.list) ? data.list : []).map((item) => normalizeRepairTraceEntry(item));
  repairIssueLogsCache = list;
  renderRepairIssueDetailPanels();
  return list;
}

async function loadRepairIssueDetail(issueId) {
  if (!repairIssueDetail) return;
  const nextIssueId = (issueId || "").toString();
  const issueChanged = activeRepairIssueId !== nextIssueId;
  activeRepairIssueId = nextIssueId;
  if (issueChanged && repairIssueLogSearch) {
    repairIssueLogSearch.value = "";
  }
  if (repairIssueSelected) repairIssueSelected.value = activeRepairIssueId;
  if (repairIssueDetailMeta) repairIssueDetailMeta.textContent = "加载中...";
  repairIssueDetail.textContent = "加载中...";
  if (repairIssueTimeline) repairIssueTimeline.textContent = "加载中...";
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}`);
  const detail = result.data || {};
  if (detail.issue) {
    detail.issue = normalizeRepairIssueRecord(detail.issue);
  }
  repairIssueDetailCache = detail;
  renderRepairIssueDetailPanels();
  await Promise.all([loadRepairIssueTimeline(issueId), loadRepairIssueLogs(issueId)]);
  startRepairIssueAutoRefresh();
}

function stopRepairIssueAutoRefresh() {
  if (!repairIssueAutoRefreshTimer) return;
  clearInterval(repairIssueAutoRefreshTimer);
  repairIssueAutoRefreshTimer = null;
}

function startRepairIssueAutoRefresh() {
  stopRepairIssueAutoRefresh();
  if (!repairIssueAutoRefresh?.checked) return;
  repairIssueAutoRefreshTimer = setInterval(async () => {
    if (!repairIssueAutoRefresh?.checked) return;
    try {
      if (getActivePageId() !== "page-repair-issues") return;
      const listOk = await loadRepairIssuesPage({ silent: true, preserveSelection: true });
      if (activeRepairIssueId) {
        const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(activeRepairIssueId)}`);
        const detail = result.data || {};
        if (detail.issue) {
          detail.issue = normalizeRepairIssueRecord(detail.issue);
        }
        repairIssueDetailCache = detail;
        renderRepairIssueDetailPanels();
        await Promise.all([loadRepairIssueTimeline(activeRepairIssueId), loadRepairIssueLogs(activeRepairIssueId)]);
      }
      updatePageRefreshStatus({
        pageId: "page-repair-issues",
        source: "auto",
        status: listOk ? "success" : "error",
        detail: listOk ? "已静默更新当前问题、时间线与日志" : "静默刷新失败，请稍后手动重试"
      });
    } catch {
      // 自动刷新失败时保持静默，避免影响管理员操作
      updatePageRefreshStatus({
        pageId: "page-repair-issues",
        source: "auto",
        status: "error",
        detail: "静默刷新失败，请稍后手动重试"
      });
    }
  }, 2500);
}

async function runRepairIssueReplay(issueId) {
  if (!repairIssueDetail) return;
  repairIssueDetail.textContent = "测试中...";
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/run-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (result.code !== 200) {
    throw new Error(result.msg || "回放测试失败");
  }
  renderRepairLogs({
    list: [
      {
        ts: Date.now(),
        stage: "REPLAY_RESULT",
        level: result?.data?.ok ? "info" : "error",
        source: "admin_run_test",
        actor: result?.data?.testedBy || "-",
        durationMs: 0,
        message: result?.data?.ok ? "回放测试通过" : `回放测试失败：${result?.data?.reason || "unknown"}`,
        meta: result?.data || {}
      }
    ]
  });
  await loadRepairIssuesPage();
  await loadRepairIssueDetail(issueId);
}

async function retryRepairIssueFromAdmin(issueId) {
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (result.code !== 200) {
    throw new Error(result.msg || "重试失败");
  }
  showToast("info", "已触发重试", "失败样本已重新进入修复队列");
  await loadRepairIssuesPage();
  await loadRepairIssueDetail(issueId);
}

async function forceRepairIssueFromAdmin(issueId) {
  const confirmed = await askOperationConfirm({
    title: "确认立即修复",
    detail: `将忽略最小样本数限制，立即把修复问题 ${issueId} 投递到修复流水线。`,
    emphasizeText: "该操作会直接触发模型修复与后续验证流程，请确认问题样本已具备代表性。",
    confirmText: issueId,
    confirmLabel: "确认立即修复",
    danger: true,
    kicker: "危险操作，请再次确认"
  });
  if (!confirmed) {
    showToast("warning", "已取消", "未执行立即修复");
    return;
  }
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/force-repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (result.code !== 200) {
    throw new Error(result.msg || "立即修复失败");
  }
  showToast("info", "已触发立即修复", "该修复问题已直接进入修复流水线，并忽略最小样本数限制");
  await loadRepairIssuesPage();
  await loadRepairIssueDetail(issueId);
}

async function deleteRepairIssueFromAdmin(issueId) {
  const confirmed = await askOperationConfirm({
    title: "确认删除修复问题",
    detail: `将删除修复问题 ${issueId}，并清理其日志、时间线与样本索引。`,
    emphasizeText: "删除后不可恢复，请确认当前问题不再需要继续排查或审计。",
    confirmText: issueId,
    confirmLabel: "确认删除",
    danger: true,
    kicker: "危险操作，请再次确认"
  });
  if (!confirmed) {
    showToast("warning", "已取消", "未执行删除操作");
    return;
  }
  stopRepairIssueAutoRefresh();
  const result = await fetchWithAuth(`/api/v1/admin/repair/issues/${encodeURIComponent(issueId)}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (result.code !== 200) {
    throw new Error(result.msg || "删除失败");
  }
  showToast("info", "已删除", "该修复问题已删除");
  await loadRepairIssuesPage();
  if (activeRepairIssueId === issueId) {
    resetRepairIssueDetail();
  }
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

function buildRefreshResultDetail(pageId, ok) {
  if (!ok) {
    return "刷新失败，请查看页面提示后重试";
  }
  if (pageId === "page-scripts") {
    return "已更新脚本统计、发布列表与摘要卡片";
  }
  if (pageId === "page-repair-issues") {
    return activeRepairIssueId
      ? "已更新修复问题列表、当前问题详情、时间线与日志"
      : "已更新修复问题列表";
  }
  if (pageId === "page-users") {
    return "已更新运维账号列表";
  }
  if (pageId === "page-runtime-logs") {
    return "已更新运行日志正文与来源摘要";
  }
  if (pageId === "page-config") {
    return "已重新加载模型配置";
  }
  return "已更新总览指标与筛选结果";
}

async function performPageRefresh(pageId, source = "manual") {
  const targetPageId = (pageId || getActivePageId() || "page-dashboard").toString();
  updatePageRefreshStatus({
    pageId: targetPageId,
    source,
    status: "loading",
    detail: source === "auto" ? "后台静默刷新中" : "正在读取最新数据"
  });
  let ok = false;
  if (targetPageId === "page-scripts") {
    ok = await loadScriptsPage();
  } else if (targetPageId === "page-repair-issues") {
    ok = await loadRepairIssuesPage({ silent: source === "auto", preserveSelection: true });
    if (ok && activeRepairIssueId) {
      await loadRepairIssueDetail(activeRepairIssueId);
    }
  } else if (targetPageId === "page-users") {
    ok = await loadUsersPage();
  } else if (targetPageId === "page-runtime-logs") {
    ok = await loadRuntimeLogs();
  } else if (targetPageId === "page-config") {
    await loadConfig();
    ok = true;
  } else {
    ok = await refreshData();
  }
  updatePageRefreshStatus({
    pageId: targetPageId,
    source,
    status: ok ? "success" : "error",
    detail: buildRefreshResultDetail(targetPageId, ok)
  });
  return ok;
}

async function checkSession() {
  try {
    await fetchWithAuth("/api/v1/admin/session");
    overlay.style.display = "none";
    await connectAdminEvents();
    await performPageRefresh("page-dashboard", "initial");
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
  await withButtonLoading(refreshBtn, "刷新中...", async () => {
    await performPageRefresh(getActivePageId(), "manual");
  });
});
if (repairIssueTableBody) {
  repairIssueTableBody.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    try {
      if (button) {
        const action = (button.dataset.action || "").toString();
        if (action === "row-menu") {
          // 行内“操作”按钮不在 .dropdown 容器内，必须阻止冒泡，
          // 否则会被 document 级点击监听立即关闭，表现为“点击没反应”。
          e.preventDefault();
          e.stopPropagation();
          const issueId = decodeURIComponent(button.dataset.issue || "");
          if (!issueId) return;
          openFloatingMenu(button, { mode: "row", issueId });
          return;
        }
        const issueId = decodeURIComponent(button.dataset.issue || "");
        if (!issueId) return;
        closeAllDropdowns();
        if (action === "detail") {
          await loadRepairIssueDetail(issueId);
        }
        return;
      }
      const row = e.target.closest("tr[data-issue-row]");
      if (!row) return;
      const issueId = decodeURIComponent(row.getAttribute("data-issue-row") || "");
      if (!issueId) return;
      await loadRepairIssueDetail(issueId);
    } catch (err) {
      repairIssueDetail.textContent = `操作失败：${err?.message || ""}`;
    }
  });
}
if (repairIssueLogReloadBtn) {
  repairIssueLogReloadBtn.addEventListener("click", async () => {
    if (!activeRepairIssueId) {
      showToast("warning", "未选择修复问题", "请先在列表中选择一条修复问题");
      return;
    }
    try {
      await withButtonLoading(repairIssueLogReloadBtn, "刷新中...", async () => {
        updatePageRefreshStatus({
          pageId: "page-repair-issues",
          source: "manual",
          status: "loading",
          detail: "正在刷新当前问题日志与时间线"
        });
        await loadRepairIssueTimeline(activeRepairIssueId);
        await loadRepairIssueLogs(activeRepairIssueId);
        updatePageRefreshStatus({
          pageId: "page-repair-issues",
          source: "manual",
          status: "success",
          detail: "已刷新当前问题日志与时间线"
        });
      });
    } catch (err) {
      updatePageRefreshStatus({
        pageId: "page-repair-issues",
        source: "manual",
        status: "error",
        detail: "日志与时间线刷新失败"
      });
      showToast("error", "刷新日志失败", err?.message || "网络错误");
    }
  });
}
if (repairIssueActionsBtn && repairIssueActions) {
  repairIssueActionsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!activeRepairIssueId) {
      showToast("warning", "未选择修复问题", "请先在列表中选择一条修复问题");
      return;
    }
    openFloatingMenu(repairIssueActionsBtn, { mode: "detail", issueId: activeRepairIssueId });
  });
}
if (repairIssueAutoRefresh) {
  repairIssueAutoRefresh.addEventListener("change", () => {
    if (repairIssueAutoRefresh.checked) {
      startRepairIssueAutoRefresh();
    } else {
      stopRepairIssueAutoRefresh();
    }
    syncRepairIssueRefreshRule();
    updatePageRefreshStatus({
      pageId: "page-repair-issues",
      source: "manual",
      status: "success",
      detail: repairIssueAutoRefresh.checked ? "已开启修复问题自动刷新" : "已关闭修复问题自动刷新"
    });
  });
}
if (repairIssueFollowLogs) {
  repairIssueFollowLogs.addEventListener("change", () => {
    renderRepairLogsTable(repairIssueLogsCache);
  });
}
if (repairIssueCopyLogsBtn) {
  repairIssueCopyLogsBtn.addEventListener("click", async () => {
    const filtered = getFilteredRepairLogs(repairIssueLogsCache, repairIssueLogSearch?.value || "");
    const text = buildRepairLogsText(filtered).trim();
    if (!text) {
      showToast("warning", "暂无日志", "请先选择一条修复问题");
      return;
    }
    try {
      await copyText(text);
      showToast("info", "已复制", `步骤日志已复制到剪贴板，共 ${filtered.length} 条`);
    } catch (e) {
      showToast("error", "复制失败", e?.message || "浏览器不支持剪贴板");
    }
  });
}
if (repairIssueLogSearch) {
  repairIssueLogSearch.addEventListener("input", () => {
    renderRepairLogs({ list: repairIssueLogsCache });
  });
}
if (repairIssueClearSearchBtn) {
  repairIssueClearSearchBtn.addEventListener("click", () => {
    if (repairIssueLogSearch) {
      repairIssueLogSearch.value = "";
    }
    renderRepairLogs({ list: repairIssueLogsCache });
  });
}
if (repairIssueLogWrap) {
  repairIssueLogWrap.addEventListener("change", () => {
    renderRepairLogs({ list: repairIssueLogsCache });
  });
}
if (repairIssueProgressSteps) {
  repairIssueProgressSteps.addEventListener("click", async (e) => {
    const step = e.target.closest(".progress-step");
    const stage = (step?.dataset?.stage || "").toString();
    if (!stage) return;
    if (repairIssueLogStage) {
      repairIssueLogStage.value = repairIssueLogStage.value === stage ? "" : stage;
      if (activeRepairIssueId) {
        await loadRepairIssueLogs(activeRepairIssueId);
      }
    }
  });
}
if (repairIssueTimelineList) {
  repairIssueTimelineList.addEventListener("click", async (e) => {
    const item = e.target.closest(".timeline-item");
    const stage = (item?.dataset?.stage || "").toString();
    if (!stage || !repairIssueLogStage) return;
    repairIssueLogStage.value = repairIssueLogStage.value === stage ? "" : stage;
    if (activeRepairIssueId) {
      await loadRepairIssueLogs(activeRepairIssueId);
    }
  });
}
if (repairIssueLogStage) {
  repairIssueLogStage.addEventListener("change", async () => {
    if (!activeRepairIssueId) return;
    await loadRepairIssueLogs(activeRepairIssueId);
  });
}
if (repairIssueLogLevel) {
  repairIssueLogLevel.addEventListener("change", async () => {
    if (!activeRepairIssueId) return;
    await loadRepairIssueLogs(activeRepairIssueId);
  });
}
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
      await withButtonLoading(createUserBtn, "新增中...", async () => {
        await createUser();
      });
    } catch (e) {
      showToast("error", "新增失败", e?.message || "网络错误");
    }
  });
}
if (newUserPasswordInput) {
  newUserPasswordInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    try {
      await withButtonLoading(createUserBtn, "新增中...", async () => {
        await createUser();
      });
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
        const confirmed = await askOperationConfirm({
          title: "确认修改账号名",
          detail: `将账号 ${username} 修改为 ${newUsername}。`,
          emphasizeText: "修改后原账号名将立即失效，请同步通知对应运维人员。",
          confirmLabel: "确认改名",
          danger: false,
          kicker: "账号变更确认"
        });
        if (!confirmed) {
          showToast("warning", "已取消", "未执行改名操作");
          return;
        }
        await withButtonLoading(btn, "修改中...", async () => {
          const result = await postWithAuth("/api/v1/admin/users/rename", { oldUsername: username, newUsername });
          if (result.code !== 200) {
            showToast("error", "修改失败", result.msg || "未知错误");
            return;
          }
          showToast("info", "修改成功", `${username} -> ${newUsername}`);
          await loadUsersPage();
        });
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
        const confirmed = await askOperationConfirm({
          title: "确认重置密码",
          detail: `将更新账号 ${username} 的登录密码。`,
          emphasizeText: "密码更新后旧密码会立即失效，请确认新的交付方式安全可靠。",
          confirmLabel: "确认改密",
          danger: true,
          kicker: "敏感操作确认"
        });
        if (!confirmed) {
          showToast("warning", "已取消", "未执行改密操作");
          return;
        }
        await withButtonLoading(btn, "修改中...", async () => {
          const result = await postWithAuth("/api/v1/admin/users/password", { username, newPassword });
          if (result.code !== 200) {
            showToast("error", "修改失败", result.msg || "未知错误");
            return;
          }
          if (input) input.value = "";
          showToast("info", "修改成功", `账号 ${username} 密码已更新`);
          await loadUsersPage();
        });
        return;
      }
      if (action === "delete-user") {
        const confirmed = await askOperationConfirm({
          title: "确认删除账号",
          detail: `将删除账号 ${username}，其登录会话会被立即失效。`,
          emphasizeText: "删除后该账号无法继续登录，请确认相关操作记录已完成交接。",
          confirmText: username,
          confirmLabel: "确认删除",
          danger: true,
          kicker: "危险操作，请再次确认"
        });
        if (!confirmed) {
          showToast("warning", "已取消", "未执行删除操作");
          return;
        }
        await withButtonLoading(btn, "删除中...", async () => {
          const result = await postWithAuth("/api/v1/admin/users/delete", { username });
          if (result.code !== 200) {
            showToast("error", "删除失败", result.msg || "未知错误");
            return;
          }
          showToast("info", "删除成功", `账号 ${username} 已删除`);
          await loadUsersPage();
        });
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
    await withButtonLoading(runtimeLogRefreshBtn, "刷新中...", async () => {
      await performPageRefresh("page-runtime-logs", "manual");
    });
  });
}
if (runtimeLogDownloadBtn) {
  runtimeLogDownloadBtn.addEventListener("click", async () => {
    if (!runtimeLogSnapshot.lines.length) {
      await performPageRefresh("page-runtime-logs", "manual");
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
    await performPageRefresh("page-runtime-logs", "manual");
  });
}

logoutBtn.addEventListener("click", async () => {
  try {
    await postWithAuth("/api/v1/admin/logout", {});
  } catch {}
  clearToken();
  closeAdminEvents();
  overlay.style.display = "flex";
});

renderRepairStageFilterOptions();
resetRepairIssueDetail();
syncRepairIssueRefreshRule();
checkSession();
applyPageMetadata("page-dashboard", "总览监控");
syncPageRefreshRuleForPage("page-dashboard");

setInterval(async () => {
  if (overlay.style.display === "none" && document.visibilityState === "visible") {
    try {
      const activePageId = getActivePageId();
      if (GLOBAL_AUTO_REFRESHABLE_PAGES.has(activePageId)) {
        await performPageRefresh(activePageId, "auto");
      }
    } catch {}
  }
}, 10000);
