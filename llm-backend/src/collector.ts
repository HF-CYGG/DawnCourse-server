import { FastifyInstance } from "fastify";
import { classifyFailure } from "./classifier.js";
import { config } from "./config.js";
import { query, withTx } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { log } from "./log.js";
import { startRepairJob } from "./repair.js";
import { getRuntimePlatformConfig } from "./runtimeConfig.js";
import { PageFingerprintInput, ParseReportInput, ParserAttemptInput } from "./types.js";
import { hostFromUrl, id, limitString, normalizeSystemType, safeJsonParse, sha256 } from "./utils.js";

const taskStore = new Map<string, { status: string; result?: unknown; error?: string; issueId?: string; createdAt: number }>();

export async function registerCollectorRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/parse/report", async (request) => {
    const body = (request.body || {}) as ParseReportInput;
    const result = await ingestParseReport(body, "parse_report");
    return apiOk(result);
  });

  app.post("/api/v1/script_feedback", async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    if (body.isSessionFinal === true && body.finalResult !== "success") {
      const report: ParseReportInput = {
        session: {
          parseSessionId: String(body.parseSessionId || id("sess")),
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
      await ingestParseReport(report, "script_feedback");
    }
    await writeFeedbackStats(body);
    return apiOk({ accepted: true });
  });

  app.post("/api/v1/parse_task", async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const taskId = id("task");
    const content = String(body.sanitizedContent || body.content || body.html || "");
    const parseSessionId = String(body.parseSessionId || id("sess"));
    const hasConsent = body.userConsent === true || body.hasUserConsent === true || Boolean(body.sanitizedContent);
    const report: ParseReportInput = {
      session: {
        parseSessionId,
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
      sanitizedSample: {
        hasUserConsent: hasConsent,
        sanitizerVersion: Number(body.sanitizerVersion || 1),
        contentSha256: content ? sha256(content) : "",
        content: hasConsent ? content : ""
      }
    };
    const issue = await ingestParseReport(report, "parse_task");
    taskStore.set(taskId, { status: "pending", issueId: issue.issueId, createdAt: Date.now() });
    if (!hasConsent) {
      taskStore.set(taskId, { status: "failed", error: "missing_user_consent", issueId: issue.issueId, createdAt: Date.now() });
      return { taskId, status: "failed", issueId: issue.issueId };
    }
    taskStore.set(taskId, { status: "processing", issueId: issue.issueId, createdAt: Date.now() });
    return { taskId, status: "processing", issueId: issue.issueId };
  });

  app.get("/api/v1/task_status", async (request) => {
    const taskId = String((request.query as Record<string, unknown>).taskId || (request.query as Record<string, unknown>).id || "");
    const task = taskStore.get(taskId);
    if (!task) return { status: "not_found", error: "task_not_found" };
    return {
      status: task.status,
      result: task.result || null,
      error: task.error || "",
      issueId: task.issueId || ""
    };
  });
}

export async function ingestParseReport(body: ParseReportInput, source: string): Promise<{ issueId: string; repairDomain: string; targetType: string; queued: boolean }> {
  const session = body.session || {};
  const parseSessionId = String(session.parseSessionId || id("sess"));
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
  let issueId = "";
  let sampleId: string | null = null;

  await withTx(async (client) => {
    await client.query(
      `INSERT INTO parse_sessions(parse_session_id, app_version_code, app_version_name, install_bucket_id_hash, school_id, school_name,
        school_system_type, import_source, source_url_host, page_fingerprint_hash, repair_domain, final_success, final_failure_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (parse_session_id)
       DO UPDATE SET final_success = EXCLUDED.final_success, final_failure_type = EXCLUDED.final_failure_type,
         repair_domain = EXCLUDED.repair_domain, updated_at = now()`,
      [
        parseSessionId,
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
        body.finalFailureType || resolution.failureType
      ]
    );
    for (const attempt of attempts) {
      await client.query(
        `INSERT INTO parser_attempts(parse_session_id, parser_name, category, parser_version, release_id, script_source, script_sha256,
          duration_ms, success, result_count, failure_type, safe_error_code, schema_valid, confidence, raw_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          parseSessionId,
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

    const existing = await client.query<{ issue_id: string; sample_count: number; user_count: number }>(
      "SELECT issue_id, sample_count, user_count FROM repair_issues WHERE issue_key = $1 FOR UPDATE",
      [resolution.issueKey]
    );
    if (existing.rows[0]) {
      issueId = existing.rows[0].issue_id;
      await client.query(
        `UPDATE repair_issues
         SET sample_count = sample_count + 1, user_count = GREATEST(user_count, 1),
           last_seen_at = now(), updated_at = now(), last_error = $2, failure_type = $3
         WHERE issue_id = $1`,
        [issueId, resolution.reason, resolution.failureType]
      );
    } else {
      issueId = id("issue");
      await client.query(
        `INSERT INTO repair_issues(issue_id, issue_key, school_id, school_name, school_system_type, source_url_host,
          page_fingerprint_hash, repair_domain, target_type, affected_script_id, affected_script_name, affected_category,
          affected_version, failure_type, sample_count, user_count, last_error, last_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,1,$15,$16)`,
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
          "reported"
        ]
      );
    }

    if (body.sanitizedSample?.hasUserConsent && content) {
      sampleId = id("sample");
      await client.query(
        `INSERT INTO failure_samples(sample_id, parse_session_id, issue_id, has_user_consent, sanitizer_version, content_sha256,
          sanitized_content, page_fingerprint_json, school_id, school_name, school_system_type, source_url_host, repair_domain)
         VALUES ($1,$2,$3,true,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          sampleId,
          parseSessionId,
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
    }
  });

  await addIssueEvent({ issueId, stage: "REPORTED", source, message: "收到失败上报", meta: { parseSessionId, repairDomain: resolution.repairDomain, targetType: resolution.targetType } });
  await addIssueEvent({ issueId, stage: "CLASSIFIED", source: "classifier", message: `失败分类：${resolution.repairDomain}`, meta: resolution as unknown as Record<string, unknown> });
  await addIssueEvent({ issueId, stage: "ISSUE_MERGED", source, message: "已归并到 Repair Issue", meta: { issueKey: resolution.issueKey, sampleId } });
  if (sampleId) await setIssueStage(issueId, "SAMPLE_READY", "sample ready");

  const queued = resolution.shouldAutoRepair && sampleId !== null;
  if (queued) {
    const runtime = await getRuntimePlatformConfig();
    const count = await query<{ sample_count: number }>("SELECT sample_count FROM repair_issues WHERE issue_id = $1", [issueId]);
    if (Number(count.rows[0]?.sample_count || 0) >= runtime.minQueueSize) {
      void startRepairJob(issueId, { actor: "collector", bypassMinQueue: false }).catch((error) => log.error("repair job failed", { issueId, error: String(error) }));
    } else {
      await addIssueEvent({ issueId, stage: "SAMPLE_READY", level: "info", message: `样本已保存，等待达到最小样本数 ${runtime.minQueueSize}` });
    }
  }

  return { issueId, repairDomain: resolution.repairDomain, targetType: resolution.targetType, queued };
}

function normalizeAttemptList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return ["zhengfang.js"];
}

async function writeFeedbackStats(body: Record<string, unknown>): Promise<void> {
  const scriptName = String(body.scriptName || "unknown.js");
  const success = body.success === true || body.finalResult === "success";
  const failureType = String(body.failureType || "unknown");
  await query(
    `INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json)
     VALUES ('client','script_feedback','script',$1,$2::jsonb)`,
    [scriptName, JSON.stringify({ success, failureType, parseSessionId: body.parseSessionId || "" })]
  );
}

export function getTaskStore(): typeof taskStore {
  return taskStore;
}

function apiOk(data: unknown): { code: number; msg: string; data: unknown } {
  return { code: 200, msg: "ok", data };
}
