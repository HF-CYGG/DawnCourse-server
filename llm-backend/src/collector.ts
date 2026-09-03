/**
 * 文件说明：负责接收解析失败上报、云端兜底解析任务与脚本反馈，并把结果接入自动脚本修复流水线。
 */
import { FastifyInstance } from "fastify";
import { classifyFailure } from "./classifier.js";
import { config } from "./config.js";
import { query, withTx } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { log } from "./log.js";
import { startRepairJob } from "./repair.js";
import { getRuntimeModelConfig, getRuntimePlatformConfig, ModelRuntimeConfig } from "./runtimeConfig.js";
import { PageFingerprintInput, ParseReportInput, ParseSessionInput, ParserAttemptInput } from "./types.js";
import { hostFromUrl, id, limitString, normalizeSystemType, safeJsonParse, sha256 } from "./utils.js";

/**
 * 内存态任务仓库：
 * - 为同进程轮询提供低延迟缓存；
 * - 重启后的任务状态与 importSessionId 仍以 CloudParseTaskStore 的持久记录为准。
 */
const taskStore = new Map<
  string,
  {
    status: string;
    importSessionId: string;
    result?: string;
    error?: string;
    issueId?: string;
    schoolId?: string;
    schoolName?: string;
    schoolSystemType?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
  }
>();

type CloudParseTaskRecord = {
  taskId: string;
  importSessionId: string;
  status: string;
  result?: string;
  error?: string;
  issueId?: string;
  schoolId?: string;
  schoolName?: string;
  schoolSystemType?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
};

export interface CloudParseTaskStore {
  create(task: CloudParseTaskRecord): Promise<void>;
  update(taskId: string, patch: Partial<CloudParseTaskRecord>): Promise<void>;
  get(taskId: string): Promise<CloudParseTaskRecord | null>;
}

export interface SchoolProfileUpsert {
  schoolId: string;
  schoolName: string;
  normalizedName: string;
  schoolSystemType: string;
  sourceHosts: string[];
  status: "reported";
  createdFromIssueId: string;
}

/**
 * 路由级依赖注入：
 * - 用于测试时替换数据库/模型/异步任务等重依赖；
 * - 生产环境不传时仍走默认实现，不改变现有行为。
 */
export interface CollectorRouteDeps {
  ingestParseReport?: typeof ingestParseReport;
  getRuntimeModelConfig?: typeof getRuntimeModelConfig;
  scheduleCloudParseTask?: (input: {
    taskId: string;
    content: string;
    summaryConfig: ModelRuntimeConfig;
    issueId: string;
    taskStore: typeof taskStore;
    cloudTaskStore: CloudParseTaskStore;
  }) => Promise<void>;
  taskStore?: typeof taskStore;
  cloudTaskStore?: CloudParseTaskStore;
  writeFeedbackStats?: (input: FeedbackStatsInput) => Promise<void>;
}

type FeedbackStatsInput = {
  scriptName: string;
  success: boolean;
  failureType: string;
  importSessionId: string;
};

/**
 * 自动修复触发依赖：
 * - 仅抽离“达到阈值后是否启动修复”的判断；
 * - 方便在无数据库环境下独立验证触发链路。
 */
export interface RepairTriggerDeps {
  getRuntimePlatformConfig?: typeof getRuntimePlatformConfig;
  query?: typeof query;
  startRepairJob?: typeof startRepairJob;
  addIssueEvent?: typeof addIssueEvent;
  logError?: (message: string, meta: Record<string, unknown>) => void;
}

export async function registerCollectorRoutes(app: FastifyInstance, deps: CollectorRouteDeps = {}): Promise<void> {
  const ingestParseReportFn = deps.ingestParseReport || ingestParseReport;
  const getRuntimeModelConfigFn = deps.getRuntimeModelConfig || getRuntimeModelConfig;
  const scheduleCloudParseTaskFn = deps.scheduleCloudParseTask || scheduleCloudParseTask;
  const routeTaskStore = deps.taskStore || taskStore;
  const writeFeedbackStatsFn = deps.writeFeedbackStats || writeFeedbackStats;
  const cloudTaskStore =
    deps.cloudTaskStore || (deps.taskStore ? createMapCloudTaskStore(routeTaskStore) : pgCloudParseTaskStore);
  app.post("/api/v1/parse/report", async (request) => {
    const body = normalizeParseReportInput((request.body || {}) as ParseReportInput);
    const result = await ingestParseReportFn(body, "parse_report");
    return apiOk(result);
  });

  app.post("/api/v1/script_feedback", async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const importSessionId = resolveImportSessionId(body);
    if (body.isSessionFinal === true && body.finalResult !== "success") {
      const report: ParseReportInput = {
        session: {
          importSessionId,
          schoolSystemType: body.schoolSystemType || "UNKNOWN",
          sourceUrl: body.sourceUrl || ""
        },
        sourceUrl: String(body.sourceUrl || ""),
        attempts: [
          {
            parserName: String(body.scriptName || "unknown.js"),
            category: String(body.category || "parsers"),
            parserVersion: Number(body.scriptVersion || 0),
            success: false,
            failureType: String(body.failureType || "parser_failure"),
            safeErrorCode: limitString(body.errorMessage || "", 120)
          }
        ],
        finalSuccess: false,
        finalFailureType: String(body.failureType || "parser_failure")
      };
      await ingestParseReportFn(report, "script_feedback");
    }
    await writeFeedbackStatsFn(buildFeedbackStatsInput(body, importSessionId));
    return apiOk({ accepted: true });
  });

  app.post("/api/v1/parse_task", async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const hasLegacyRawContent = Object.hasOwn(body, "content") || Object.hasOwn(body, "html");
    if (hasLegacyRawContent) {
      return {
        code: 400,
        msg: "请求包含未脱敏的 legacy content/html 字段",
        data: null
      };
    }
    // 服务端只接收客户端脱敏器明确产出的字段，绝不把 content/html 这类原始别名当作样本。
    const content = String(body.sanitizedContent || "");
    const importSessionId = resolveImportSessionId(body);
    const explicitConsent = body.userConsent === true || body.hasUserConsent === true;
    const sanitizerVersion = Object.hasOwn(body, "sanitizerVersion") ? Number(body.sanitizerVersion) : 1;
    const sanitizerVersionValid = Number.isFinite(sanitizerVersion) && sanitizerVersion > 0;
    if (!sanitizerVersionValid) {
      return {
        code: 400,
        msg: "sanitizerVersion 必须是有限正数",
        data: null
      };
    }
    const computedHash = content ? sha256(content) : "";
    const providedHash = String(body.contentSha256 || "").trim();
    const contentHashValid = !providedHash || providedHash.toLowerCase() === computedHash.toLowerCase();
    const hasConsent = explicitConsent && sanitizerVersionValid && contentHashValid && Boolean(content.trim());
    const report: ParseReportInput = {
      session: {
        importSessionId,
        schoolId: body.schoolId || "",
        schoolName: body.schoolName || "",
        schoolSystemType: body.schoolSystemType || "",
        sourceUrl: body.sourceUrl || ""
      },
      sourceUrl: String(body.sourceUrl || ""),
      attempts: normalizeAttemptList(body.attemptedParsers).map((parserName) => ({
        parserName,
        category: "parsers",
        parserVersion: 0,
        success: false,
        failureType: String(body.failureType || "parser_failure")
      })),
      finalSuccess: false,
      finalFailureType: String(body.failureType || "parser_failure"),
      failureStage: String(body.failureStage || ""),
      repairDomain: body.repairDomain as ParseReportInput["repairDomain"],
      targetType: body.targetType as ParseReportInput["targetType"],
      consentAt: body.consentAt as ParseReportInput["consentAt"],
      sanitizedSample: {
        hasUserConsent: hasConsent,
        sanitizerVersion,
        contentSha256: computedHash,
        content: hasConsent ? content : ""
      }
    };
    const issue = await ingestParseReportFn(report, "parse_task");
    if (explicitConsent && !contentHashValid) {
      return {
        code: 400,
        msg: "contentSha256 mismatch",
        data: { issueId: issue.issueId }
      };
    }
    if (!hasConsent) {
      return {
        code: 400,
        msg: "用户未同意上传脱敏内容，无法发起云端兜底解析",
        data: { issueId: issue.issueId }
      };
    }
    if (!content.trim()) {
      return {
        code: 400,
        msg: "云端兜底解析缺少可用内容",
        data: { issueId: issue.issueId }
      };
    }

    const summaryConfig = await getRuntimeModelConfigFn("summary");
    if (!isCloudParseProviderReady(summaryConfig)) {
      return {
        code: 503,
        msg: "云端解析服务暂未配置",
        data: { issueId: issue.issueId }
      };
    }

    const taskId = id("task");
    const now = Date.now();
    const taskRecord = {
      taskId,
      importSessionId,
      status: "processing",
      issueId: issue.issueId,
      schoolId: String(body.schoolId || ""),
      schoolName: String(body.schoolName || ""),
      schoolSystemType: String(body.schoolSystemType || ""),
      createdAt: now,
      startedAt: now
    };
    await cloudTaskStore.create(taskRecord);
    routeTaskStore.set(taskId, taskRecord);
    void scheduleCloudParseTaskFn({
      taskId,
      content,
      summaryConfig,
      issueId: issue.issueId,
      taskStore: routeTaskStore,
      cloudTaskStore
    }).catch((error) => {
      const existing = routeTaskStore.get(taskId);
      const failedTask = {
        status: "failed",
        importSessionId: existing?.importSessionId || importSessionId,
        issueId: existing?.issueId || issue.issueId,
        schoolId: existing?.schoolId || "",
        schoolName: existing?.schoolName || "",
        schoolSystemType: existing?.schoolSystemType || "",
        createdAt: existing?.createdAt || Date.now(),
        startedAt: existing?.startedAt,
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      };
      routeTaskStore.set(taskId, failedTask);
      void cloudTaskStore.update(taskId, failedTask);
      log.error("cloud parse task failed", { taskId, issueId: issue.issueId, error: String(error) });
    });
    return apiOk({ taskId, status: "processing", issueId: issue.issueId, importSessionId });
  });

  app.get("/api/v1/task_status", async (request) => {
    const taskId = String((request.query as Record<string, unknown>).taskId || (request.query as Record<string, unknown>).id || "");
    const task = (await cloudTaskStore.get(taskId)) || routeTaskStore.get(taskId);
    if (!task) {
      return {
        code: 404,
        msg: "任务不存在或已过期",
        data: { status: "failed", error: "task_not_found" }
      };
    }
    return apiOk({
      status: task.status,
      result: task.result || null,
      error: task.error || "",
      issueId: task.issueId || "",
      importSessionId: task.importSessionId || "",
      schoolId: task.schoolId || "",
      schoolName: task.schoolName || "",
      schoolSystemType: task.schoolSystemType || "",
      startedAt: task.startedAt || 0,
      completedAt: task.completedAt || 0
    });
  });
}

const IMPORT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 新协议优先 importSessionId，parseSessionId 只作为旧客户端的入站兼容字段。 */
function resolveImportSessionId(source: Record<string, unknown> | ParseSessionInput): string {
  const candidate = source.importSessionId ?? source.parseSessionId;
  return typeof candidate === "string" && IMPORT_SESSION_ID_PATTERN.test(candidate) ? candidate : id("sess");
}

/**
 * 把所有进入 collector 的报告归一化为新协议写法。
 *
 * 本地 Profile 身份不能离开设备，故所有嵌套对象都逐字段重建后才会进入持久化与下游分类；
 * legacy parseSessionId 同样不会再被写入新的对象、事件或审计记录。客户端自由提供的
 * classificationHint 没有服务端消费者，故不属于规范协议，也不会持久化。
 */
function normalizeParseReportInput(body: ParseReportInput): ParseReportInput {
  const rawBody = isPlainRecord(body) ? body : {};
  const rawSession = isPlainRecord(rawBody.session) ? rawBody.session : {};
  const canonicalSession: ParseSessionInput = {
    importSessionId: resolveImportSessionId(rawSession)
  };
  copyScalar(rawSession, "appVersionCode", canonicalSession);
  copyScalar(rawSession, "appVersionName", canonicalSession);
  copyScalar(rawSession, "installBucketIdHash", canonicalSession);
  copyScalar(rawSession, "importSource", canonicalSession);
  copyScalar(rawSession, "schoolId", canonicalSession);
  copyScalar(rawSession, "schoolName", canonicalSession);
  copyScalar(rawSession, "schoolSystemType", canonicalSession);
  copyScalar(rawSession, "sourceUrl", canonicalSession);

  const normalized: ParseReportInput = { session: canonicalSession };
  const pageFingerprint = normalizePageFingerprint(rawBody.pageFingerprint);
  if (pageFingerprint) normalized.pageFingerprint = pageFingerprint;
  const attempts = normalizeParserAttempts(rawBody.attempts);
  if (attempts) normalized.attempts = attempts;
  if (typeof rawBody.finalSuccess === "boolean") normalized.finalSuccess = rawBody.finalSuccess;
  copyString(rawBody, "finalFailureType", normalized);
  copyString(rawBody, "failureStage", normalized);
  copyRepairDomain(rawBody, normalized);
  copyTargetType(rawBody, normalized);
  copyString(rawBody, "sourceUrl", normalized);
  if (typeof rawBody.consentAt === "number" || typeof rawBody.consentAt === "string") {
    normalized.consentAt = rawBody.consentAt;
  }
  const sanitizedSample = normalizeSanitizedSample(rawBody.sanitizedSample);
  if (sanitizedSample) normalized.sanitizedSample = sanitizedSample;
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyScalar(source: object, key: string, target: object): void {
  const sourceRecord = source as Record<string, unknown>;
  const targetRecord = target as Record<string, unknown>;
  const value = sourceRecord[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") targetRecord[key] = value;
}

function copyString(source: object, key: string, target: object): void {
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord[key] === "string") (target as Record<string, unknown>)[key] = sourceRecord[key];
}

function copyBoolean(source: object, key: string, target: object): void {
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord[key] === "boolean") (target as Record<string, unknown>)[key] = sourceRecord[key];
}

function copyNumber(source: object, key: string, target: object): void {
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord[key] === "number" && Number.isFinite(sourceRecord[key])) {
    (target as Record<string, unknown>)[key] = sourceRecord[key];
  }
}

function normalizePageFingerprint(value: unknown): PageFingerprintInput | undefined {
  if (!isPlainRecord(value)) return undefined;
  const normalized: PageFingerprintInput = {};
  copyString(value, "host", normalized);
  copyString(value, "pathPattern", normalized);
  copyString(value, "titleHash", normalized);
  copyString(value, "bodyTextHash", normalized);
  copyString(value, "htmlStructureHash", normalized);
  copyString(value, "tableShape", normalized);
  copyString(value, "formActionHash", normalized);
  copyBoolean(value, "hasCaptcha", normalized);
  copyBoolean(value, "hasLoginKeyword", normalized);
  copyBoolean(value, "hasCourseKeyword", normalized);
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeParserAttempts(value: unknown): ParserAttemptInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap((attempt) => {
    if (!isPlainRecord(attempt)) return [];
    const safeAttempt: ParserAttemptInput = {};
    copyString(attempt, "parserName", safeAttempt);
    copyString(attempt, "category", safeAttempt);
    copyNumber(attempt, "parserVersion", safeAttempt);
    copyString(attempt, "releaseId", safeAttempt);
    copyString(attempt, "scriptSource", safeAttempt);
    copyString(attempt, "scriptSha256", safeAttempt);
    copyNumber(attempt, "durationMs", safeAttempt);
    copyBoolean(attempt, "success", safeAttempt);
    copyNumber(attempt, "resultCount", safeAttempt);
    copyString(attempt, "failureType", safeAttempt);
    copyString(attempt, "safeErrorCode", safeAttempt);
    copyBoolean(attempt, "schemaValid", safeAttempt);
    copyNumber(attempt, "confidence", safeAttempt);
    return [safeAttempt];
  });
  return normalized;
}

function normalizeSanitizedSample(value: unknown): NonNullable<ParseReportInput["sanitizedSample"]> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const normalized: NonNullable<ParseReportInput["sanitizedSample"]> = {};
  copyBoolean(value, "hasUserConsent", normalized);
  copyNumber(value, "sanitizerVersion", normalized);
  copyString(value, "contentSha256", normalized);
  copyString(value, "content", normalized);
  return Object.keys(normalized).length ? normalized : undefined;
}

function copyRepairDomain(source: Record<string, unknown>, target: ParseReportInput): void {
  if (
    source.repairDomain === "PARSER_FAILURE" ||
    source.repairDomain === "NAVIGATION_FAILURE" ||
    source.repairDomain === "TERM_EXTRACT_FAILURE" ||
    source.repairDomain === "LOGIN_OR_CAPTCHA" ||
    source.repairDomain === "NON_TIMETABLE_PAGE" ||
    source.repairDomain === "CLOUD_PARSE_FAILURE"
  ) {
    target.repairDomain = source.repairDomain;
  }
}

function copyTargetType(source: Record<string, unknown>, target: ParseReportInput): void {
  if (
    source.targetType === "parser" ||
    source.targetType === "navigation" ||
    source.targetType === "term_extractor" ||
    source.targetType === "cloud_parse" ||
    source.targetType === "none"
  ) {
    target.targetType = source.targetType;
  }
}

export async function ingestParseReport(body: ParseReportInput, source: string): Promise<{ issueId: string; repairDomain: string; targetType: string; queued: boolean }> {
  body = normalizeParseReportInput(body);
  const session = body.session || {};
  const importSessionId = resolveImportSessionId(session);
  const sourceUrl = body.sourceUrl || String(session.sourceUrl || "");
  const host = (body.pageFingerprint?.host || hostFromUrl(sourceUrl)).toLowerCase();
  const content = body.sanitizedSample?.hasUserConsent ? String(body.sanitizedSample.content || "") : "";
  if (content.length > config.maxContentLength) throw new Error("content_too_large");
  const attempts = body.attempts?.length ? body.attempts : [{ parserName: "zhengfang.js", category: "parsers", success: false }];
  const fingerprint = body.pageFingerprint || {};
  const fingerprintHash = sha256(JSON.stringify(fingerprint));
  const resolution = classifyFailure({
    session,
    pageFingerprint: fingerprint,
    attempts,
    finalFailureType: body.finalFailureType,
    failureStage: body.failureStage,
    repairDomain: body.repairDomain,
    targetType: body.targetType,
    sourceUrl,
    sanitizedContent: content
  });

  const schoolSystemType = normalizeSystemType(String(session.schoolSystemType || ""));
  const schoolId = String(session.schoolId || host || "");
  const schoolName = String(session.schoolName || schoolId || "");
  const consentAt = normalizeConsentAt(body.consentAt);
  let issueId = "";
  let sampleId: string | null = null;

  await withTx(async (client) => {
    await client.query(
      `INSERT INTO parse_sessions(parse_session_id, app_version_code, app_version_name, install_bucket_id_hash, school_id, school_name,
        school_system_type, import_source, source_url_host, page_fingerprint_hash, repair_domain, final_success, final_failure_type,
        failure_stage, target_type, source_url, classification_hint_json, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
       ON CONFLICT (parse_session_id)
       DO UPDATE SET final_success = EXCLUDED.final_success, final_failure_type = EXCLUDED.final_failure_type,
        repair_domain = EXCLUDED.repair_domain,
        failure_stage = EXCLUDED.failure_stage,
        target_type = EXCLUDED.target_type,
        source_url = EXCLUDED.source_url,
        classification_hint_json = EXCLUDED.classification_hint_json,
        consent_at = COALESCE(EXCLUDED.consent_at, parse_sessions.consent_at),
        school_name = CASE
          WHEN trim(parse_sessions.school_name) = '' THEN EXCLUDED.school_name
          WHEN lower(parse_sessions.school_name) = lower(parse_sessions.school_id) THEN EXCLUDED.school_name
          WHEN lower(parse_sessions.school_name) = lower(parse_sessions.source_url_host) THEN EXCLUDED.school_name
          WHEN trim(EXCLUDED.school_name) = '' THEN parse_sessions.school_name
          ELSE parse_sessions.school_name
        END,
        updated_at = now()`,
      [
        importSessionId,
        Number(session.appVersionCode || 0),
        String(session.appVersionName || ""),
        String(session.installBucketIdHash || ""),
        schoolId,
        schoolName,
        schoolSystemType,
        String(session.importSource || "UNKNOWN"),
        host,
        fingerprintHash,
        resolution.repairDomain,
        body.finalSuccess === true,
        body.finalFailureType || resolution.failureType,
        body.failureStage || "",
        resolution.targetType,
        sourceUrl,
        // classificationHint 曾是客户端自由对象；没有服务端消费者，规范化入口已明确不接收它。
        JSON.stringify({}),
        consentAt
      ]
    );
    for (const attempt of attempts) {
      await client.query(
        `INSERT INTO parser_attempts(parse_session_id, parser_name, category, parser_version, release_id, script_source, script_sha256,
          duration_ms, success, result_count, failure_type, safe_error_code, schema_valid, confidence, raw_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          importSessionId,
          attempt.parserName || resolution.scriptName,
          attempt.category || resolution.category,
          Number(attempt.parserVersion || 0),
          attempt.releaseId || null,
          attempt.scriptSource || null,
          attempt.scriptSha256 || null,
          Number(attempt.durationMs || 0),
          attempt.success === true,
          Number(attempt.resultCount || 0),
          attempt.failureType || resolution.failureType,
          attempt.safeErrorCode || null,
          attempt.schemaValid ?? null,
          attempt.confidence ?? null,
          JSON.stringify(attempt)
        ]
      );
    }

    const sessionIssue = await client.query<{ issue_id: string | null }>(
      "SELECT issue_id FROM parse_sessions WHERE parse_session_id = $1 FOR UPDATE",
      [importSessionId]
    );
    const existing = await client.query<{ issue_id: string; sample_count: number; user_count: number }>(
      "SELECT issue_id, sample_count, user_count FROM repair_issues WHERE issue_key = $1 FOR UPDATE",
      [resolution.issueKey]
    );
    const reused = resolveIssueReuse({
      sessionIssueId: String(sessionIssue.rows[0]?.issue_id || ""),
      issueKeyIssueId: String(existing.rows[0]?.issue_id || "")
    });
    if (reused) {
      issueId = reused.issueId;
      const existingIssue = await client.query<{ school_name: string | null; school_id: string | null; source_url_host: string | null }>(
        "SELECT school_name, school_id, source_url_host FROM repair_issues WHERE issue_id = $1 FOR UPDATE",
        [issueId]
      );
      const preferredSchoolName = resolvePreferredSchoolName({
        currentSchoolName: String(existingIssue.rows[0]?.school_name || ""),
        incomingSchoolName: schoolName,
        schoolId: String(existingIssue.rows[0]?.school_id || schoolId),
        sourceHost: String(existingIssue.rows[0]?.source_url_host || host)
      });
      await client.query(
        `UPDATE repair_issues
         SET user_count = GREATEST(user_count, 1),
           school_name = $4,
           last_seen_at = now(), updated_at = now(), last_error = $2, failure_type = $3,
           repair_domain = $5, target_type = $6, affected_script_id = $7, affected_script_name = $8,
           affected_category = $9, affected_version = $10,
           classification_confidence = $11,
           classification_evidence_json = $12::jsonb
         WHERE issue_id = $1`,
        [
          issueId,
          resolution.reason,
          resolution.failureType,
          preferredSchoolName,
          resolution.repairDomain,
          resolution.targetType,
          resolution.scriptId,
          resolution.scriptName,
          resolution.category,
          resolution.version,
          resolution.confidence,
          JSON.stringify(resolution.evidence)
        ]
      );
    } else {
      issueId = id("issue");
      await client.query(
        `INSERT INTO repair_issues(issue_id, issue_key, school_id, school_name, school_system_type, source_url_host,
          page_fingerprint_hash, repair_domain, target_type, affected_script_id, affected_script_name, affected_category,
          affected_version, failure_type, sample_count, user_count, last_error, last_result, classification_confidence,
          classification_evidence_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,1,$15,$16,$17,$18::jsonb)`,
        [
          issueId,
          resolution.issueKey,
          schoolId,
          schoolName,
          schoolSystemType,
          resolution.sourceHost || host,
          fingerprintHash,
          resolution.repairDomain,
          resolution.targetType,
          resolution.scriptId,
          resolution.scriptName,
          resolution.category,
          resolution.version,
          resolution.failureType,
          resolution.reason,
          "reported",
          resolution.confidence,
          JSON.stringify(resolution.evidence)
        ]
      );
    }
    await client.query("UPDATE parse_sessions SET issue_id = $2, updated_at = now() WHERE parse_session_id = $1", [importSessionId, issueId]);

    if (body.sanitizedSample?.hasUserConsent && content) {
      const candidateSampleId = id("sample");
      const insertSample = await client.query<{ sample_id: string }>(
        `INSERT INTO failure_samples(sample_id, parse_session_id, issue_id, has_user_consent, sanitizer_version, content_sha256,
          sanitized_content, page_fingerprint_json, school_id, school_name, school_system_type, source_url_host, repair_domain)
         SELECT $1,$2,$3,true,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12
         WHERE NOT EXISTS (
           SELECT 1
           FROM failure_samples
           WHERE issue_id = $3
             AND content_sha256 = $5
             AND has_user_consent = true
             AND COALESCE(sanitized_content, '') <> ''
         )
         AND NOT EXISTS (
           SELECT 1
           FROM failure_samples
           WHERE parse_session_id = $2
             AND content_sha256 = $5
             AND has_user_consent = true
             AND COALESCE(sanitized_content, '') <> ''
         )
         RETURNING sample_id`,
        [
          candidateSampleId,
          importSessionId,
          issueId,
          Number(body.sanitizedSample.sanitizerVersion || 1),
          body.sanitizedSample.contentSha256 || sha256(content),
          content,
          JSON.stringify(fingerprint),
          schoolId,
          schoolName,
          schoolSystemType,
          host,
          resolution.repairDomain
        ]
      );
      sampleId = insertSample.rows[0]?.sample_id || null;
    }
    await client.query(
      `UPDATE repair_issues
       SET sample_count = (
           SELECT COUNT(*)::int FROM failure_samples
           WHERE issue_id = $1 AND has_user_consent = true AND COALESCE(sanitized_content, '') <> ''
         ),
         user_count = GREATEST(
           1,
           (
             SELECT COUNT(DISTINCT COALESCE(NULLIF(ps.install_bucket_id_hash, ''), fs.parse_session_id))::int
             FROM failure_samples fs
             LEFT JOIN parse_sessions ps ON ps.parse_session_id = fs.parse_session_id
             WHERE fs.issue_id = $1
           )
         ),
         updated_at = now()
       WHERE issue_id = $1`,
      [issueId]
    );
  });

  await addIssueEvent({ issueId, stage: "REPORTED", source, message: "收到失败上报", meta: { importSessionId, repairDomain: resolution.repairDomain, targetType: resolution.targetType } });
  await addIssueEvent({ issueId, stage: "CLASSIFIED", source: "classifier", message: `失败分类：${resolution.repairDomain}`, meta: resolution as unknown as Record<string, unknown> });
  await addIssueEvent({ issueId, stage: "ISSUE_MERGED", source, message: "已归并到 Repair Issue", meta: { issueKey: resolution.issueKey, sampleId } });

  await upsertSchoolProfile(
    buildSchoolProfileUpsert({
      schoolId: String(session.schoolId || ""),
      schoolName,
      schoolSystemType,
      sourceUrl,
      issueId
    })
  ).catch((error) => {
    log.error("school profile upsert failed", { issueId, error: String(error) });
  });

  const postIngestPolicy = resolvePostIngestPolicy({
    hasSample: sampleId !== null,
    shouldAutoRepair: resolution.shouldAutoRepair
  });
  await setIssueStage(issueId, postIngestPolicy.nextStage, postIngestPolicy.nextStage === "SAMPLE_READY" ? "sample ready" : "issue merged");
  if (sampleId && !resolution.shouldAutoRepair) {
    await addIssueEvent({
      issueId,
      stage: "CLASSIFIED",
      source: "collector",
      level: "info",
      message: "该问题已保存样本，但当前分类不进入自动修复",
      meta: { repairDomain: resolution.repairDomain, targetType: resolution.targetType }
    });
  }

  const queued = postIngestPolicy.queued;
  await triggerRepairIfReady({ issueId, queued, hasSample: sampleId !== null });

  return { issueId, repairDomain: resolution.repairDomain, targetType: resolution.targetType, queued };
}

/**
 * 自动修复触发判断：
 * - 只有允许自动修复且已保存脱敏样本时，才继续检查样本阈值；
 * - 达标后异步启动修复任务，未达标则追加可观测事件，便于后台回放验证。
 */
export async function triggerRepairIfReady(
  input: { issueId: string; queued: boolean; hasSample: boolean },
  deps: RepairTriggerDeps = {}
): Promise<boolean> {
  if (!input.queued || !input.hasSample) return false;
  const getRuntimePlatformConfigFn = deps.getRuntimePlatformConfig || getRuntimePlatformConfig;
  const queryFn = deps.query || query;
  const startRepairJobFn = deps.startRepairJob || startRepairJob;
  const addIssueEventFn = deps.addIssueEvent || addIssueEvent;
  const logErrorFn = deps.logError || ((message, meta) => log.error(message, meta));
  const runtime = await getRuntimePlatformConfigFn();
  const count = await queryFn<{ sample_count: number }>("SELECT sample_count FROM repair_issues WHERE issue_id = $1", [input.issueId]);
  if (Number(count.rows[0]?.sample_count || 0) >= runtime.minQueueSize) {
    void startRepairJobFn(input.issueId, { actor: "collector", bypassMinQueue: false }).catch((error) =>
      logErrorFn("repair job failed", { issueId: input.issueId, error: String(error) })
    );
    return true;
  }
  await addIssueEventFn({ issueId: input.issueId, stage: "SAMPLE_READY", level: "info", message: `样本已保存，等待达到最小样本数 ${runtime.minQueueSize}` });
  return false;
}

/**
 * Issue 归并决策：
 * - 同一个 parseSession 已经归并过 issue 时，后续上报必须优先复用，避免单次提交裂单；
 * - 若当前会话还没有 issue，再退回 issue_key 归并；
 * - 两者都没有时，由上层创建新 issue。
 */
export function resolveIssueReuse(input: { sessionIssueId: string; issueKeyIssueId: string }): { issueId: string; reason: "parse_session" | "issue_key" } | null {
  const sessionIssueId = input.sessionIssueId.trim();
  if (sessionIssueId) {
    return { issueId: sessionIssueId, reason: "parse_session" };
  }
  const issueKeyIssueId = input.issueKeyIssueId.trim();
  if (issueKeyIssueId) {
    return { issueId: issueKeyIssueId, reason: "issue_key" };
  }
  return null;
}

/**
 * 失败上报落库后的阶段决策：
 * - 只有“已保存样本 + 允许自动修复”才进入 SAMPLE_READY；
 * - 其余情况保持在 ISSUE_MERGED，表示分类与归并已完成，但尚未进入自动修复。
 */
export function resolvePostIngestPolicy(input: {
  hasSample: boolean;
  shouldAutoRepair: boolean;
}): { nextStage: "ISSUE_MERGED" | "SAMPLE_READY"; queued: boolean } {
  if (input.hasSample && input.shouldAutoRepair) {
    return { nextStage: "SAMPLE_READY", queued: true };
  }
  return { nextStage: "ISSUE_MERGED", queued: false };
}

/**
 * 学校名称择优规则：
 * - 真实学校名优先于 host / schoolId 这类回退占位值；
 * - 一旦已有真实学校名，后续空值或 host 不得覆盖。
 */
export function resolvePreferredSchoolName(input: {
  currentSchoolName: string;
  incomingSchoolName: string;
  schoolId: string;
  sourceHost: string;
}): string {
  const currentSchoolName = input.currentSchoolName.trim();
  const incomingSchoolName = input.incomingSchoolName.trim();
  const schoolId = input.schoolId.trim().toLowerCase();
  const sourceHost = input.sourceHost.trim().toLowerCase();
  if (!incomingSchoolName) return currentSchoolName;
  const currentLower = currentSchoolName.toLowerCase();
  const currentIsFallback = !currentSchoolName || currentLower === schoolId || currentLower === sourceHost;
  const incomingLower = incomingSchoolName.toLowerCase();
  const incomingIsFallback = incomingLower === schoolId || incomingLower === sourceHost;
  if (currentIsFallback && !incomingIsFallback) return incomingSchoolName;
  if (!currentSchoolName) return incomingSchoolName;
  return currentSchoolName;
}

function normalizeAttemptList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return ["zhengfang.js"];
}

function buildFeedbackStatsInput(body: Record<string, unknown>, importSessionId: string): FeedbackStatsInput {
  return {
    scriptName: String(body.scriptName || "unknown.js"),
    success: body.success === true || body.finalResult === "success",
    failureType: String(body.failureType || "unknown"),
    importSessionId
  };
}

async function writeFeedbackStats(input: FeedbackStatsInput): Promise<void> {
  await query(
    `INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json)
     VALUES ('client','script_feedback','script',$1,$2::jsonb)`,
    [
      input.scriptName,
      JSON.stringify({
        success: input.success,
        failureType: input.failureType,
        importSessionId: input.importSessionId
      })
    ]
  );
}

export function getTaskStore(): typeof taskStore {
  return taskStore;
}

export function buildSchoolProfileUpsertForTest(input: {
  schoolId: string;
  schoolName: string;
  schoolSystemType: string;
  sourceUrl: string;
  issueId: string;
}): SchoolProfileUpsert {
  return buildSchoolProfileUpsert(input);
}

function buildSchoolProfileUpsert(input: {
  schoolId: string;
  schoolName: string;
  schoolSystemType: string;
  sourceUrl: string;
  issueId: string;
}): SchoolProfileUpsert {
  const schoolSystemType = normalizeSystemType(input.schoolSystemType || "UNKNOWN");
  const sourceHost = hostFromUrl(input.sourceUrl);
  const normalizedName = normalizeSchoolProfileName(input.schoolName || sourceHost || "unknown");
  const providedId = input.schoolId.trim();
  const schoolId = providedId || `school:${schoolSystemType.toLowerCase()}:${normalizedName}`;
  return {
    schoolId,
    schoolName: input.schoolName.trim() || sourceHost || schoolId,
    normalizedName,
    schoolSystemType,
    sourceHosts: sourceHost ? [sourceHost] : [],
    status: "reported",
    createdFromIssueId: input.issueId
  };
}

function normalizeSchoolProfileName(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

async function upsertSchoolProfile(profile: SchoolProfileUpsert): Promise<void> {
  await query(
    `INSERT INTO school_profiles(school_id, school_name, normalized_name, school_system_type, source_hosts_json, status, created_from_issue_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (school_id)
     DO UPDATE SET
       school_name = CASE
         WHEN trim(school_profiles.school_name) = '' THEN EXCLUDED.school_name
         ELSE school_profiles.school_name
       END,
       normalized_name = EXCLUDED.normalized_name,
       school_system_type = CASE
         WHEN school_profiles.school_system_type = 'UNKNOWN' THEN EXCLUDED.school_system_type
         ELSE school_profiles.school_system_type
       END,
       source_hosts_json = (
         SELECT jsonb_agg(DISTINCT value)
         FROM jsonb_array_elements_text(school_profiles.source_hosts_json || EXCLUDED.source_hosts_json) AS value
       ),
       updated_at = now()`,
    [
      profile.schoolId,
      profile.schoolName,
      profile.normalizedName,
      profile.schoolSystemType,
      JSON.stringify(profile.sourceHosts),
      profile.status,
      profile.createdFromIssueId
    ]
  );
}

function createMapCloudTaskStore(store: typeof taskStore): CloudParseTaskStore {
  return {
    async create(task) {
      store.set(task.taskId, task);
    },
    async update(taskId, patch) {
      const existing = store.get(taskId);
      if (!existing) return;
      store.set(taskId, { ...existing, ...patch });
    },
    async get(taskId) {
      const task = store.get(taskId);
      return task ? { taskId, ...task } : null;
    }
  };
}

const pgCloudParseTaskStore: CloudParseTaskStore = {
  async create(task) {
    await query(
      `INSERT INTO cloud_parse_tasks(task_id, import_session_id, status, issue_id, school_id, school_name, school_system_type, created_at, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0),to_timestamp($9 / 1000.0),now())
       ON CONFLICT (task_id)
       DO UPDATE SET import_session_id = EXCLUDED.import_session_id, status = EXCLUDED.status, issue_id = EXCLUDED.issue_id, updated_at = now()`,
      [
        task.taskId,
        task.importSessionId,
        task.status,
        task.issueId || "",
        task.schoolId || "",
        task.schoolName || "",
        task.schoolSystemType || "",
        task.createdAt,
        task.startedAt || task.createdAt
      ]
    );
  },
  async update(taskId, patch) {
    await query(
      `UPDATE cloud_parse_tasks
       SET status = COALESCE($2, status),
         result_text = COALESCE($3, result_text),
         error_text = COALESCE($4, error_text),
         completed_at = CASE WHEN $5::bigint IS NULL THEN completed_at ELSE to_timestamp($5 / 1000.0) END,
         updated_at = now()
       WHERE task_id = $1`,
      [taskId, patch.status || null, patch.result || null, patch.error || null, patch.completedAt || null]
    );
  },
  async get(taskId) {
    const result = await query<{
      task_id: string;
      status: string;
      result_text: string | null;
      error_text: string | null;
      issue_id: string | null;
      import_session_id: string | null;
      school_id: string | null;
      school_name: string | null;
      school_system_type: string | null;
      created_at_ms: string;
      started_at_ms: string | null;
      completed_at_ms: string | null;
    }>(
      `SELECT task_id, import_session_id, status, result_text, error_text, issue_id, school_id, school_name, school_system_type,
         floor(extract(epoch from created_at) * 1000)::bigint::text AS created_at_ms,
         floor(extract(epoch from started_at) * 1000)::bigint::text AS started_at_ms,
         floor(extract(epoch from completed_at) * 1000)::bigint::text AS completed_at_ms
       FROM cloud_parse_tasks WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      taskId: row.task_id,
      importSessionId: row.import_session_id || "",
      status: row.status,
      result: row.result_text || undefined,
      error: row.error_text || undefined,
      issueId: row.issue_id || undefined,
      schoolId: row.school_id || undefined,
      schoolName: row.school_name || undefined,
      schoolSystemType: row.school_system_type || undefined,
      createdAt: Number(row.created_at_ms || 0),
      startedAt: row.started_at_ms ? Number(row.started_at_ms) : undefined,
      completedAt: row.completed_at_ms ? Number(row.completed_at_ms) : undefined
    };
  }
};

/**
 * 统一调度云端兜底解析任务：
 * - 默认实现直接调用当前文件内的解析逻辑；
 * - 测试环境可替换为同步/伪造结果，避免真实模型依赖。
 */
async function scheduleCloudParseTask(input: {
  taskId: string;
  content: string;
  summaryConfig: ModelRuntimeConfig;
  issueId: string;
  taskStore: typeof taskStore;
  cloudTaskStore: CloudParseTaskStore;
}): Promise<void> {
  await runCloudParseTask(input.taskId, input.content, input.summaryConfig, input.taskStore, input.cloudTaskStore);
}

/**
 * 后台执行单次云端兜底解析，并把结果回写到任务状态仓库。
 * 这里直接产出 ParsedCourse JSON 数组文本，和客户端轮询接口形成闭环。
 */
async function runCloudParseTask(
  taskId: string,
  content: string,
  summaryConfig: ModelRuntimeConfig,
  targetTaskStore: typeof taskStore = taskStore,
  targetCloudTaskStore: CloudParseTaskStore = createMapCloudTaskStore(targetTaskStore)
): Promise<void> {
  const existing = targetTaskStore.get(taskId);
  if (!existing) return;
  const parseResult = await callCloudParseProvider(content, summaryConfig);
  const nextTask = {
    ...existing,
    status: parseResult.resultText != null ? "success" : "failed",
    result: parseResult.resultText || undefined,
    error: parseResult.resultText != null ? "" : parseResult.reason,
    completedAt: Date.now()
  };
  targetTaskStore.set(taskId, nextTask);
  await targetCloudTaskStore.update(taskId, nextTask);
}

/**
 * 顺序尝试多套提示词策略，优先保证输出能被客户端直接解析成 ParsedCourse 列表。
 */
async function callCloudParseProvider(
  content: string,
  summaryConfig: ModelRuntimeConfig
): Promise<{ resultText: string | null; reason: string }> {
  const strategies: Array<"standard" | "strict" | "repair"> = ["standard", "strict", "repair"];
  const failedReasons: string[] = [];
  for (const strategy of strategies) {
    const attempt = await callCloudParseProviderOnce(content, strategy, summaryConfig);
    if (attempt.resultText != null) {
      return { resultText: attempt.resultText, reason: "" };
    }
    failedReasons.push(attempt.reason);
  }
  return {
    resultText: null,
    reason: failedReasons.filter(Boolean).join(" | ") || "模型输出不可解析"
  };
}

/**
 * 单次调用模型完成兜底解析。
 * 当前 PG 版服务优先兼容 OpenAI 风格接口，若后续需要 Gemini/Responses API 可继续在这里扩展。
 */
async function callCloudParseProviderOnce(
  content: string,
  strategy: "standard" | "strict" | "repair",
  summaryConfig: ModelRuntimeConfig
): Promise<{ resultText: string | null; reason: string }> {
  if (summaryConfig.provider.trim().toLowerCase() === "gemini") {
    return { resultText: null, reason: "当前 PG 版服务暂未接入 Gemini 兜底解析" };
  }
  const prompt = buildCloudParsePrompt(content, strategy);
  const response = await callOpenAiCompatible(summaryConfig, prompt.systemPrompt, prompt.userPrompt);
  if (!response.ok) {
    return { resultText: null, reason: response.error || "模型调用失败" };
  }
  const resultText = extractJsonArray(response.text);
  if (resultText == null) {
    return { resultText: null, reason: `${strategy}: 模型输出不是合法课程 JSON 数组` };
  }
  return { resultText, reason: "" };
}

/**
 * 构建云端兜底解析提示词。
 * 三种策略分别对应“直接提取”“严格纠错”“修复后提取”，用来提升脏数据场景下的成功率。
 */
function buildCloudParsePrompt(
  content: string,
  strategy: "standard" | "strict" | "repair"
): { systemPrompt: string; userPrompt: string } {
  const baseSystem =
    "你是课程表解析助手，只输出严格 JSON 数组，不要包含任何解释、Markdown、代码块。" +
    "数组元素必须符合 ParsedCourse 结构：" +
    "name,teacher,location,dayOfWeek,startSection,duration,startWeek,endWeek,weekType。";
  if (strategy === "strict") {
    return {
      systemPrompt:
        baseSystem +
        "必须进行字段类型纠正：dayOfWeek 限制 1-7，startSection/duration/startWeek/endWeek 必须是整数，weekType 必须是 0/1/2。",
      userPrompt:
        "请严格提取并纠正字段类型，仅输出 JSON 数组。" +
        "若信息缺失，teacher/location 可为空字符串，其余核心字段必须可用。\n" +
        `课表内容如下：\n${content}\n只输出 JSON 数组。`
    };
  }
  if (strategy === "repair") {
    return {
      systemPrompt:
        baseSystem +
        "当原文混乱时，先在内部修复字段，再输出最终 JSON 数组。禁止输出中间过程，禁止输出非 JSON。",
      userPrompt:
        "请执行“修复后提取”：合并同一课程重复行、修正周次/节次格式、补全可推断字段，最后仅输出 JSON 数组。\n" +
        `课表内容如下：\n${content}\n只输出 JSON 数组。`
    };
  }
  return {
    systemPrompt: baseSystem + "所有字段必须齐全，整数必须是数字类型。",
    userPrompt:
      "请从以下内容中提取课程信息，输出 JSON 数组，示例格式：" +
      "[{\"name\":\"高等数学\",\"teacher\":\"李四\",\"location\":\"A-301\",\"dayOfWeek\":1," +
      "\"startSection\":1,\"duration\":2,\"startWeek\":1,\"endWeek\":16,\"weekType\":0}]\n" +
      `课表内容如下：\n${content}\n只输出 JSON 数组。`
  };
}

/**
 * 调用 OpenAI 兼容接口获取文本。
 * 这里沿用脚本修复模块的请求约定，保证兜底解析与自动修复共用同一套运行时模型配置。
 */
async function callOpenAiCompatible(
  summaryConfig: ModelRuntimeConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<{ ok: boolean; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), summaryConfig.timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(summaryConfig.provider, summaryConfig.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${summaryConfig.apiKey}`
      },
      body: JSON.stringify({
        model: summaryConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        ...parseExtraBody(summaryConfig.extraBody)
      }),
      signal: controller.signal
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, text: "", error: json?.error?.message || `http_${response.status}` };
    }
    return {
      ok: true,
      text: String(json?.choices?.[0]?.message?.content || "")
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 兼容额外请求体配置，避免管理后台保存的 JSON 扩展参数在兜底解析链路中失效。
 */
function parseExtraBody(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 统一拼接 OpenAI 风格地址，兼容 DeepSeek/Qwen 等常见兼容平台。
 */
function chatCompletionsUrl(provider: string, baseUrl: string): string {
  const base = (baseUrl || "").replace(/\/$/, "");
  if (!base) return "https://api.openai.com/v1/chat/completions";
  if (/\/chat\/completions$/.test(base)) return base;
  if (provider === "deepseek") return `${base}/chat/completions`;
  if (provider === "qwen" || base.includes("dashscope.aliyuncs.com")) {
    return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  }
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
}

/**
 * 从模型输出中提取 JSON 数组文本，并重新序列化成稳定字符串，方便客户端直接反序列化。
 */
function extractJsonArray(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const direct = tryNormalizeJsonArray(trimmed);
  if (direct != null) return direct;
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = tryNormalizeJsonArray(fencedMatch?.[1] || "");
  if (fenced != null) return fenced;
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  return tryNormalizeJsonArray(arrayMatch?.[0] || "");
}

/**
 * 校验文本是否为合法 JSON 数组，并输出标准化后的紧凑 JSON。
 */
function tryNormalizeJsonArray(rawText: string): string | null {
  if (!rawText.trim()) return null;
  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * 判断兜底解析模型是否已经具备可调用的最小配置。
 */
function isCloudParseProviderReady(summaryConfig: ModelRuntimeConfig): boolean {
  return summaryConfig.apiKey.trim().length > 0 && summaryConfig.model.trim().length > 0;
}

function normalizeConsentAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function apiOk(data: unknown): { code: number; msg: string; data: unknown } {
  return { code: 200, msg: "ok", data };
}
