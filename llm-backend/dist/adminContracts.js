/**
 * 文件说明：运维后台接口契约转换工具。
 * 负责把数据库记录、后台缓存与日志文件整理为 `server/html/admin/admin.js` 当前直接消费的结构。
 */
/**
 * 运行日志来源枚举。
 * 前端运行日志页会根据这些 key 展示中文来源标签与缺失状态。
 */
export const RUNTIME_LOG_SOURCE_KEYS = ["backend", "nginx_access", "nginx_error", "admin"];
/**
 * 日志来源中文标签。
 * 该映射要与前端展示语义保持一致，避免暴露晦涩技术词。
 */
export const RUNTIME_LOG_SOURCE_LABELS = {
    backend: "llm-backend",
    nginx_access: "nginx 访问日志",
    nginx_error: "nginx 错误日志",
    admin: "管理后台缓存"
};
/**
 * 格式化后台缓存日志为可直接显示的单行文本。
 * 统一把时间、级别与额外信息拼成一行，便于“全部来源”模式直接合并展示。
 */
export function formatAdminBufferLine(entry) {
    const extraText = entry.extra ? ` ${JSON.stringify(entry.extra)}` : "";
    return `[admin:${String(entry.level || "info")}] ${formatTimestamp(entry.createdAt)} ${String(entry.message || "")}${extraText}`;
}
/**
 * 构建运行日志接口的统一响应。
 * 该函数只负责契约输出，不关心具体来源来自文件还是内存。
 */
export function buildRuntimeLogPayload(input) {
    const loadedAt = Number(input.loadedAt || Date.now());
    const sourceCounts = input.sourceCounts || {};
    const missingSources = Array.isArray(input.missingSources) ? input.missingSources : [];
    const sourceDetails = RUNTIME_LOG_SOURCE_KEYS.map((key) => ({
        key,
        label: RUNTIME_LOG_SOURCE_LABELS[key],
        path: input.files[key] || "",
        lineCount: Number(sourceCounts[key] || 0),
        missing: missingSources.includes(key)
    }));
    return {
        source: String(input.resolvedSource || input.requestedSource || "all"),
        requestedSource: String(input.requestedSource || "all"),
        requestedLimit: Math.max(0, Number(input.requestedLimit || 0)),
        actualLimit: Math.max(0, Number(input.requestedLimit || 0)),
        loadedAt,
        lineCount: Array.isArray(input.lines) ? input.lines.length : 0,
        availableSources: [...RUNTIME_LOG_SOURCE_KEYS],
        sourceDetails,
        files: input.files,
        lines: Array.isArray(input.lines) ? input.lines : [],
        sourceCounts,
        missingSources
    };
}
/**
 * 规范化单条历史事件。
 * 统一兜底必需字段，避免前端渲染时反复判空。
 */
export function normalizeScriptHistoryEvent(input) {
    const issueIds = normalizeIssueIds(input.issueId, input.context?.issueIds);
    const metaAppliedBy = String(input.meta?.appliedBy || input.appliedBy || "");
    return {
        type: String(input.type || "event"),
        createdAt: Number(input.createdAt || input.meta?.updatedAt || 0),
        appliedBy: String(input.appliedBy || metaAppliedBy || ""),
        schoolId: String(input.schoolId || ""),
        meta: {
            scriptName: String(input.meta?.scriptName || ""),
            version: Number(input.meta?.version || 0),
            parentVersion: Number(input.meta?.parentVersion || 0),
            releaseStage: String(input.meta?.releaseStage || ""),
            updatedAt: Number(input.meta?.updatedAt || input.createdAt || 0),
            appliedBy: metaAppliedBy
        },
        releaseStage: String(input.meta?.releaseStage || ""),
        context: {
            issueId: String(input.issueId || ""),
            issueIds,
            schoolName: String(input.schoolName || ""),
            ...(input.context || {})
        },
        failure: input.failure || null
    };
}
/**
 * 把脚本发布记录与审计事件合并成前端可读的时间线。
 * 基本策略：
 * - `pending` 发布记录保留为“待发布”事件
 * - 没有审计事件兜底的发布记录保留为“写入”事件
 * - `publish_release / rollback_release` 审计日志映射为显式发布 / 回滚事件
 */
export function buildScriptHistoryEntries(input) {
    const normalizedScriptName = String(input.scriptName || "");
    const releaseRows = Array.isArray(input.releaseRows) ? input.releaseRows : [];
    const auditRows = Array.isArray(input.auditRows) ? input.auditRows : [];
    const releaseIdsWithAudit = new Set(auditRows
        .map((row) => String(row.release_id || ""))
        .filter(Boolean));
    const releaseEvents = releaseRows
        .map((row) => {
        const releaseStage = String(row.release_stage || "");
        const releaseId = String(row.release_id || "");
        if (releaseStage !== "pending" && releaseIdsWithAudit.has(releaseId)) {
            return null;
        }
        const type = releaseStage === "pending" ? "pending" : String(row.created_by || "") === "seed" ? "apply" : "auto_repair";
        return normalizeScriptHistoryEvent({
            type,
            createdAt: parseTimestamp(row.created_at),
            appliedBy: String(row.created_by || row.approved_by || ""),
            schoolId: String(row.school_id || ""),
            schoolName: String(row.school_name || ""),
            issueId: String(row.issue_id || ""),
            meta: {
                scriptName: normalizedScriptName,
                version: Number(row.version || 0),
                parentVersion: Number(row.parent_version || 0),
                releaseStage,
                updatedAt: parseTimestamp(row.published_at || row.approved_at || row.created_at),
                appliedBy: String(row.approved_by || row.created_by || "")
            },
            context: {
                mode: releaseStage === "pending" ? "pending_release" : "release_write",
                issueCategories: [],
                changelog: String(row.changelog || "")
            }
        });
    })
        .filter((item) => Boolean(item));
    const auditEvents = auditRows.map((row) => {
        const action = String(row.action || "");
        const stage = String(row.detail_stage || row.release_stage || "");
        const type = action === "publish_release"
            ? stage === "canary"
                ? "promote_canary"
                : "promote_active"
            : action === "rollback_release"
                ? "rollback_admin"
                : "event";
        const actor = String(row.actor || row.approved_by || "");
        const issueId = String(row.issue_id || "");
        const parentReleaseId = String(row.detail_parent_release_id || row.parent_release_id || "");
        return normalizeScriptHistoryEvent({
            type,
            createdAt: parseTimestamp(row.audit_created_at || row.created_at),
            appliedBy: actor,
            schoolId: String(row.school_id || ""),
            schoolName: String(row.school_name || ""),
            issueId,
            meta: {
                scriptName: normalizedScriptName,
                version: Number(row.version || 0),
                parentVersion: Number(row.parent_version || 0),
                releaseStage: stage || String(row.release_stage || ""),
                updatedAt: parseTimestamp(row.audit_created_at || row.published_at || row.created_at),
                appliedBy: actor
            },
            context: {
                mode: action,
                issueIds: normalizeIssueIds(issueId),
                parentReleaseId,
                stage,
                issueCategories: []
            }
        });
    });
    return [...releaseEvents, ...auditEvents]
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, Math.max(1, Number(input.limit || 1)));
}
/**
 * 规范化 issueId 列表。
 * 前端历史面板会优先读取 `context.issueIds`，所以这里统一转为数组。
 */
function normalizeIssueIds(issueId, rawIssueIds) {
    if (Array.isArray(rawIssueIds)) {
        return rawIssueIds.map((item) => String(item || "").trim()).filter(Boolean);
    }
    const direct = String(issueId || "").trim();
    return direct ? [direct] : [];
}
/**
 * 解析数据库时间戳。
 * 输入既可能是 `Date`、时间戳数字，也可能是 ISO 字符串。
 */
function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    const text = String(value || "").trim();
    if (!text)
        return 0;
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0)
        return numeric;
    const parsed = new Date(text).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * 格式化时间戳为 ISO 字符串。
 * 运行日志行直接展示该值，便于排查多来源日志混合后的时间顺序。
 */
function formatTimestamp(value) {
    const time = Number(value || 0);
    if (!time)
        return "-";
    return new Date(time).toISOString();
}
