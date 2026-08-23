/**
 * 文件说明：Dawn Course 服务端运维后台路由。
 * 负责管理后台登录、会话校验、账号管理、配置管理与修复运维接口。
 */

import fs from "node:fs";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import {
  buildRuntimeLogPayload,
  buildScriptHistoryEntries,
  formatAdminBufferLine,
  type AdminBufferEntry,
  type RuntimeLogSourceKey
} from "./adminContracts.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { describeScriptRepairWorkflow, formatScriptRepairWorkflowLabel, resolveScriptRepairWorkflow } from "./repairWorkflow.js";
import { chatCompletionsUrl, getAutoRepairBlockedReason, runReplayOnly, startRepairJob } from "./repair.js";
import { getAdminConfigPayload } from "./runtimeConfig.js";
import { log } from "./log.js";
import { limitString, id, sha256 } from "./utils.js";
import {
  disableScriptRelease,
  publishScriptRelease,
  rollbackScriptRelease,
  type ScriptReleaseAdminResult
} from "./scriptReleaseAdminService.js";
import { createUploadedScriptRelease, revalidateScriptRelease, type ScriptUploadInput } from "./scriptUpload.js";

type AdminRequest = FastifyRequest & { adminUser?: string };
const eventStreamTokens = new Map<string, { username: string; expiresAt: number }>();
const adminLogBuffer: AdminBufferEntry[] = [];

/**
 * 路由级依赖注入：
 * - 让关键运维路由可以在无数据库、无外部服务时做轻量集成验证；
 * - 默认仍然落回真实实现，不影响生产流程。
 */
export interface AdminRouteDeps {
  ensureBuiltinAdminUser?: () => Promise<void>;
  authRequired?: (request: AdminRequest, reply: FastifyReply) => Promise<void>;
  runReplayOnly?: typeof runReplayOnly;
  startRepairJob?: typeof startRepairJob;
  addIssueEvent?: typeof addIssueEvent;
  publishScriptRelease?: typeof publishScriptRelease;
  rollbackScriptRelease?: typeof rollbackScriptRelease;
  disableScriptRelease?: typeof disableScriptRelease;
  createUploadedScriptRelease?: typeof createUploadedScriptRelease;
  revalidateScriptRelease?: typeof revalidateScriptRelease;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps = {}): Promise<void> {
  const ensureBuiltinAdminUserFn = deps.ensureBuiltinAdminUser || ensureBuiltinAdminUser;
  const authRequiredFn = deps.authRequired || authRequired;
  const runReplayOnlyFn = deps.runReplayOnly || runReplayOnly;
  const startRepairJobFn = deps.startRepairJob || startRepairJob;
  const addIssueEventFn = deps.addIssueEvent || addIssueEvent;
  const publishScriptReleaseFn = deps.publishScriptRelease || publishScriptRelease;
  const rollbackScriptReleaseFn = deps.rollbackScriptRelease || rollbackScriptRelease;
  const disableScriptReleaseFn = deps.disableScriptRelease || disableScriptRelease;
  const createUploadedScriptReleaseFn = deps.createUploadedScriptRelease || createUploadedScriptRelease;
  const revalidateScriptReleaseFn = deps.revalidateScriptRelease || revalidateScriptRelease;
  await ensureBuiltinAdminUserFn();

  app.post("/api/v1/admin/login", async (request, reply) => {
    const body = (request.body || {}) as Record<string, string>;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const target = await findAdminUser(username);
    if (!target || hashAdminPassword(password, target.passwordSalt) !== target.passwordHash) {
      return reply.code(401).send(apiError(401, "账号或密码错误"));
    }
    const token = id("adm");
    const expiresAt = new Date(Date.now() + config.adminSessionTtlMs);
    await query("INSERT INTO admin_sessions(token, username, expires_at) VALUES ($1,$2,$3)", [token, username, expiresAt]);
    await touchAdminUserLogin(username);
    pushAdminLog("info", "管理后台登录成功", { source: "admin-auth", username });
    return apiOk({ token, username, expiresAt: expiresAt.getTime() });
  });

  app.get("/api/v1/admin/session", { preHandler: authRequiredFn }, async (request: AdminRequest) => {
    return apiOk({ authenticated: true, username: request.adminUser || "" });
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/v1/admin/logout",
    preHandler: authRequiredFn,
    handler: async (request: AdminRequest) => {
      const token = getBearer(request);
      if (token) await query("DELETE FROM admin_sessions WHERE token = $1", [token]);
      pushAdminLog("info", "管理后台已退出登录", { source: "admin-auth", username: request.adminUser || "" });
      return apiOk({ loggedOut: true });
    }
  });

  app.get("/api/v1/admin/users", { preHandler: authRequiredFn }, async () => {
    await ensureBuiltinAdminUserFn();
    return apiOk({ list: await listAdminUsers() });
  });

  app.post("/api/v1/admin/users", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const result = await createAdminUser(username, password);
    if (!result.ok) {
      return reply.code(result.code).send(apiError(result.code, result.msg));
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "create_admin_user",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    pushAdminLog("info", "新增管理账号", { source: "admin-user", operator: request.adminUser || "admin", username });
    return apiOk({ created: true, username });
  });

  app.post("/api/v1/admin/users/rename", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const oldUsername = String(body.oldUsername || "").trim();
    const newUsername = String(body.newUsername || "").trim();
    const result = await renameAdminUser(oldUsername, newUsername);
    if (!result.ok) {
      return reply.code(result.code).send(apiError(result.code, result.msg));
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "rename_admin_user",
      "admin_user",
      oldUsername,
      JSON.stringify({ oldUsername, newUsername })
    ]);
    pushAdminLog("warning", "修改管理账号", {
      source: "admin-user",
      operator: request.adminUser || "admin",
      oldUsername,
      newUsername
    });
    return apiOk({ renamed: true, oldUsername, newUsername });
  });

  app.post("/api/v1/admin/users/password", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const newPassword = String(body.newPassword || "").trim();
    const result = await updateAdminUserPassword(username, newPassword);
    if (!result.ok) {
      return reply.code(result.code).send(apiError(result.code, result.msg));
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "reset_admin_user_password",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    pushAdminLog("warning", "重置管理账号密码", {
      source: "admin-user",
      operator: request.adminUser || "admin",
      username
    });
    return apiOk({ updated: true, username });
  });

  app.post("/api/v1/admin/users/delete", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const actor = request.adminUser || "admin";
    const result = await deleteAdminUser(username, actor);
    if (!result.ok) {
      return reply.code(result.code).send(apiError(result.code, result.msg));
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      actor,
      "delete_admin_user",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    pushAdminLog("warning", "删除管理账号", { source: "admin-user", operator: actor, username });
    return apiOk({ deleted: true, username });
  });

  app.post("/api/v1/admin/events/token", { preHandler: authRequiredFn }, async (request: AdminRequest) => {
    const token = id("evt");
    const expiresAt = Date.now() + 5 * 60 * 1000;
    eventStreamTokens.set(token, { username: request.adminUser || "admin", expiresAt });
    cleanupEventStreamTokens();
    return apiOk({ token, expiresAt });
  });

  app.get("/api/v1/admin/events", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const streamToken = q.streamToken || q.token || "";
    const stream = eventStreamTokens.get(streamToken);
    if (!stream || stream.expiresAt <= Date.now()) {
      eventStreamTokens.delete(streamToken);
      return reply.code(401).send(apiError(401, "登录状态已失效，请重新登录"));
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, username: stream.username, ts: Date.now() })}\n\n`);
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 25000);
    request.raw.on("close", () => {
      clearInterval(timer);
    });
  });

  app.post("/api/v1/admin/client_error", { preHandler: authRequiredFn }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    log.warn("admin client error", {
      actor: request.adminUser || "admin",
      message: limitString(String(body.message || ""), 300),
      stack: limitString(String(body.stack || ""), 1000)
    });
    pushAdminLog("error", limitString(String(body.message || "client_error"), 300), {
      source: "client",
      username: request.adminUser || "admin",
      stack: limitString(String(body.stack || ""), 1000),
      url: limitString(String(body.url || ""), 300)
    });
    return apiOk({ accepted: true });
  });

  app.get("/api/v1/admin/data", { preHandler: authRequiredFn }, async () => {
    const stats = await loadAdminStats();
    return apiOk(stats);
  });

  app.get("/api/v1/admin/config", { preHandler: authRequiredFn }, async () => {
    return apiOk(await loadModelConfig());
  });

  app.post("/api/v1/admin/config", { preHandler: authRequiredFn }, async (request) => {
    const body = request.body || {};
    await query(
      `INSERT INTO system_config(key, value_json) VALUES ('model_config',$1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()`,
      [JSON.stringify(body)]
    );
    return apiOk({ saved: true });
  });

  app.post("/api/v1/admin/config/test", { preHandler: authRequiredFn }, async (request) => {
    const started = Date.now();
    const body = (request.body || {}) as Record<string, string>;
    const provider = body.provider || body.summaryProvider || body.scriptProvider || "gpt";
    const model = body.model || body.summaryModel || body.scriptModel || "";
    const apiKey = body.apiKey || body.summaryApiKey || body.scriptApiKey || "";
    const baseUrl = body.baseUrl || body.summaryBaseUrl || body.scriptBaseUrl || "";
    if (!apiKey || !model) {
      return apiOk({ ok: false, provider, model, statusCode: 0, latencyMs: 0, errorCode: "missing_config", errorSummary: "missing apiKey or model" });
    }
    const timeoutMs = Number(body.timeoutMs || 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const extraBody = safeParse(body.extraBody || "") || {};
    try {
      const response = await fetch(chatCompletionsUrl(provider, baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Return ok." }],
          max_tokens: 8,
          temperature: 0,
          ...(extraBody && typeof extraBody === "object" && !Array.isArray(extraBody) ? extraBody : {})
        }),
        signal: controller.signal
      });
      const text = await response.text();
      let errorSummary = "";
      if (!response.ok) {
        const json = safeParse(text);
        errorSummary = json?.error?.message || limitString(text, 200) || "request failed";
      }
      return apiOk({
        ok: response.ok,
        provider,
        model,
        statusCode: response.status,
        latencyMs: Date.now() - started,
        errorCode: response.ok ? "" : "http_error",
        errorSummary,
        errorMessage: errorSummary
      });
    } catch (error) {
      return apiOk({
        ok: false,
        provider,
        model,
        statusCode: 0,
        latencyMs: Date.now() - started,
        errorCode: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed",
        errorSummary: error instanceof Error ? error.message : String(error),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/api/v1/admin/repair/issues", { preHandler: authRequiredFn }, async () => {
    const rows = await query(
      `SELECT i.*, e.created_at AS last_step_at
       FROM repair_issues i
       LEFT JOIN LATERAL (
         SELECT created_at FROM repair_issue_events e WHERE e.issue_id = i.issue_id ORDER BY created_at DESC LIMIT 1
       ) e ON true
       ORDER BY i.last_seen_at DESC LIMIT 200`
    );
    return apiOk({ list: rows.rows.map(formatIssue) });
  });

  app.get("/api/v1/admin/repair/issues/:id", { preHandler: authRequiredFn }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    const issue = await query("SELECT * FROM repair_issues WHERE issue_id = $1", [issueId]);
    const samples = await query(
      "SELECT sample_id, content_sha256, sanitizer_version, created_at, left(sanitized_content, 5000) AS preview FROM failure_samples WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20",
      [issueId]
    );
    const reports = await query("SELECT * FROM runner_reports WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20", [issueId]);
    const jobs = await query("SELECT * FROM repair_jobs WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20", [issueId]);
    return apiOk({ issue: issue.rows[0] ? formatIssue(issue.rows[0]) : null, samples: samples.rows, reports: reports.rows, jobs: jobs.rows });
  });

  app.get("/api/v1/admin/repair/issues/:id/timeline", { preHandler: authRequiredFn }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    const rows = await query(
      "SELECT * FROM repair_issue_events WHERE issue_id = $1 ORDER BY created_at ASC LIMIT 300",
      [issueId]
    );
    return apiOk({ list: rows.rows.map(formatEvent) });
  });

  app.get("/api/v1/admin/repair/issues/:id/logs", { preHandler: authRequiredFn }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    const q = request.query as Record<string, string | undefined>;
    const stage = q.stage || "";
    const level = q.level || "";
    const rows = await query(
      `SELECT * FROM repair_issue_events
       WHERE issue_id = $1 AND ($2 = '' OR stage = $2) AND ($3 = '' OR level = $3)
       ORDER BY created_at DESC LIMIT 300`,
      [issueId, stage, level]
    );
    return apiOk({ list: rows.rows.map(formatEvent) });
  });

  app.post("/api/v1/admin/repair/issues/:id/run-test", { preHandler: authRequiredFn }, async (request: AdminRequest) => {
    const issueId = (request.params as { id: string }).id;
    const result = await runReplayOnlyFn(issueId, request.adminUser || "admin");
    return apiOk({ ...result, testedBy: request.adminUser || "admin" });
  });

  app.post("/api/v1/admin/repair/issues/:id/retry", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const issueId = (request.params as { id: string }).id;
    const result = await startRepairJobFn(issueId, { actor: request.adminUser || "admin", bypassMinQueue: false });
    if (!result.started && result.reason) {
      const code = result.reason === "问题不存在" ? 404 : 409;
      return reply.code(code).send(apiError(code, result.reason));
    }
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/force-repair", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const issueId = (request.params as { id: string }).id;
    const result = await startRepairJobFn(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
    if (!result.started && result.reason) {
      const code = result.reason === "问题不存在" ? 404 : 409;
      return reply.code(code).send(apiError(code, result.reason));
    }
    if (result.started) {
      await addIssueEventFn({
        issueId,
        stage: "SAMPLE_READY",
        actor: request.adminUser || "admin",
        source: "admin_force_repair",
        message: "管理员立即修复，忽略最小样本数限制"
      });
    }
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/run", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const issueId = (request.params as { id: string }).id;
    const result = await startRepairJobFn(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
    if (!result.started && result.reason) {
      const code = result.reason === "问题不存在" ? 404 : 409;
      return reply.code(code).send(apiError(code, result.reason));
    }
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/delete", { preHandler: authRequiredFn }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    await query("DELETE FROM repair_issue_events WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM failure_samples WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM runner_reports WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM repair_jobs WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM repair_issues WHERE issue_id = $1", [issueId]);
    return apiOk({ deleted: true });
  });

  app.get("/api/v1/admin/scripts", { preHandler: authRequiredFn }, async () => {
    const rows = await query(
      `SELECT r.*, a.content_sha256, a.signature, parent.version AS parent_version,
         COALESCE(metrics.verified_count,0) AS verified_count,
         COALESCE(metrics.trial_passed_count,0) AS trial_passed_count,
         COALESCE(metrics.activated_count,0) AS activated_count,
         COALESCE(metrics.failed_count,0) AS failed_count,
         COALESCE(metrics.quarantined_count,0) AS quarantined_count,
         COALESCE(metrics.rolled_back_count,0) AS rolled_back_count
       FROM script_releases r
       JOIN script_artifacts a ON a.release_id = r.release_id
       LEFT JOIN script_releases parent ON parent.release_id = r.parent_release_id
       LEFT JOIN (
         SELECT release_id,
           SUM(event_count) FILTER (WHERE event_type = 'verified') AS verified_count,
           SUM(event_count) FILTER (WHERE event_type = 'trial_passed') AS trial_passed_count,
           SUM(event_count) FILTER (WHERE event_type = 'activated') AS activated_count,
           SUM(event_count) FILTER (WHERE event_type = 'failed') AS failed_count,
           SUM(event_count) FILTER (WHERE event_type = 'quarantined') AS quarantined_count,
           SUM(event_count) FILTER (WHERE event_type = 'rolled_back') AS rolled_back_count
         FROM script_activation_metrics GROUP BY release_id
       ) metrics ON metrics.release_id = r.release_id
       ORDER BY r.created_at DESC LIMIT 300`
    );
    return apiOk({ list: rows.rows.map(formatRelease) });
  });

  app.post("/api/v1/admin/scripts/uploads", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    try {
      const result = await createUploadedScriptReleaseFn(
        (request.body || {}) as ScriptUploadInput,
        request.adminUser || "admin"
      );
      pushAdminLog("info", "script candidate uploaded", {
        source: "script-release",
        actor: request.adminUser || "admin",
        releaseId: result.releaseId,
        scriptKey: result.scriptKey
      });
      return apiOk(result);
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.post("/api/v1/admin/scripts/releases/:id/revalidate", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const releaseId = (request.params as { id: string }).id;
    try {
      const result = await revalidateScriptReleaseFn(
        releaseId,
        (request.body || {}) as Partial<ScriptUploadInput>,
        request.adminUser || "admin"
      );
      return apiOk(result);
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.get("/api/v1/admin/scripts/releases/:id", { preHandler: authRequiredFn }, async (request, reply) => {
    const releaseId = (request.params as { id: string }).id;
    const releaseResult = await query(
      `SELECT r.*, a.content, a.content_sha256, a.signature, a.alg,
         parent.version AS parent_version, parent_artifact.content AS parent_content
       FROM script_releases r
       JOIN script_artifacts a ON a.release_id = r.release_id
       LEFT JOIN script_releases parent ON parent.release_id = r.parent_release_id
       LEFT JOIN script_artifacts parent_artifact ON parent_artifact.release_id = parent.release_id
       WHERE r.release_id = $1 LIMIT 1`,
      [releaseId]
    );
    const release = releaseResult.rows[0];
    if (!release) return reply.code(404).send(apiError(404, "脚本版本不存在"));
    const [dependencies, validations, audits, metrics] = await Promise.all([
      query(
        `SELECT d.load_order,dr.release_id,dr.name,dr.version,da.content_sha256
         FROM script_release_dependencies d
         JOIN script_releases dr ON dr.release_id = d.dependency_release_id
         JOIN script_artifacts da ON da.release_id = dr.release_id
         WHERE d.release_id = $1 ORDER BY d.load_order`,
        [releaseId]
      ),
      query("SELECT * FROM script_manual_validations WHERE release_id = $1 ORDER BY created_at DESC", [releaseId]),
      query("SELECT actor,action,detail_json,created_at FROM audit_logs WHERE target_type = 'script_release' AND target_id = $1 ORDER BY created_at DESC", [releaseId]),
      query(
        `SELECT metric_date,school_id,school_system_type,event_type,error_code,SUM(event_count)::bigint AS event_count,MAX(last_event_at) AS last_event_at
         FROM script_activation_metrics WHERE release_id = $1
         GROUP BY metric_date,school_id,school_system_type,event_type,error_code
         ORDER BY metric_date DESC,last_event_at DESC`,
        [releaseId]
      )
    ]);
    return apiOk({
      release: formatRelease(release),
      content: release.content || "",
      parentContent: release.parent_content || "",
      validationReport: release.validation_report_json || {},
      dependencies: dependencies.rows,
      manualValidations: validations.rows,
      timeline: audits.rows,
      activationMetrics: metrics.rows
    });
  });

  app.get("/api/v1/admin/scripts/activation-metrics", { preHandler: authRequiredFn }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const releaseId = String(q.releaseId || "").trim();
    const rows = await query(
      `SELECT m.metric_date,m.release_id,r.script_key,r.name,m.school_id,m.school_system_type,
         m.event_type,m.error_code,SUM(m.event_count)::bigint AS event_count,MAX(m.last_event_at) AS last_event_at
       FROM script_activation_metrics m
       JOIN script_releases r ON r.release_id = m.release_id
       WHERE ($1 = '' OR m.release_id = $1)
       GROUP BY m.metric_date,m.release_id,r.script_key,r.name,m.school_id,m.school_system_type,m.event_type,m.error_code
       ORDER BY m.metric_date DESC,last_event_at DESC LIMIT 1000`,
      [releaseId]
    );
    return apiOk({ list: rows.rows });
  });

  app.get("/api/v1/admin/unmatched-schools", { preHandler: authRequiredFn }, async () => {
    const rows = await query(
      `SELECT sp.school_id,sp.school_name,sp.school_system_type,sp.status,sp.updated_at,
         COALESCE(samples.sample_count,0) AS sample_count,
         generic_release.release_id AS generic_release_id,
         generic_release.name AS generic_script_name,
         school_release.release_id AS school_release_id,
         school_release.name AS school_script_name,
         school_release.release_stage AS school_release_stage,
         school_release.validation_status AS school_validation_status,
         sp.created_from_issue_id
       FROM school_profiles sp
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS sample_count FROM failure_samples fs
         WHERE fs.school_id = sp.school_id AND fs.has_user_consent = true AND fs.sanitized_content <> ''
       ) samples ON true
       LEFT JOIN LATERAL (
         SELECT release_id,name FROM script_releases
         WHERE category = 'parsers' AND scope_kind = 'system' AND scope_id = sp.school_system_type
           AND release_stage IN ('active','canary') AND status = 'enabled' AND kill_switch = false
         ORDER BY CASE WHEN release_stage = 'active' THEN 2 ELSE 1 END DESC,version DESC LIMIT 1
       ) generic_release ON true
       LEFT JOIN LATERAL (
         SELECT release_id,name,release_stage,validation_status FROM script_releases
         WHERE category = 'parsers' AND scope_kind = 'school' AND scope_id = sp.school_id
         ORDER BY created_at DESC LIMIT 1
       ) school_release ON true
       ORDER BY sample_count DESC,sp.updated_at DESC LIMIT 500`
    );
    return apiOk({ list: rows.rows });
  });

  app.get("/api/v1/admin/script_content", { preHandler: authRequiredFn }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const row = await query("SELECT content FROM script_artifacts WHERE name = $1 ORDER BY version DESC LIMIT 1", [q.scriptName || q.name || ""]);
    return apiOk({ content: row.rows[0]?.content || "" });
  });

  app.post("/api/v1/admin/scripts/releases", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const releaseId = String(body.releaseId || "");
    const targetStage = String(body.releaseStage || body.stage || "canary");
    const rolloutPercent = targetStage === "active" ? 100 : Number(body.rolloutPercent ?? 10);
    if (!releaseId) return reply.code(400).send(apiError(400, "缺少 releaseId"));
    try {
      const result = await publishScriptReleaseFn(releaseId, targetStage, rolloutPercent, request.adminUser || "admin");
      await recordPublishedIssue(result, request.adminUser || "admin");
      pushAdminLog("info", "script release published", { source: "script-release", actor: request.adminUser || "admin", releaseId, stage: targetStage, rolloutPercent });
      return apiOk(result);
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.post("/api/v1/admin/promote_script", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const releaseId = String(body.releaseId || "");
    if (!releaseId) return reply.code(400).send(apiError(400, "旧版按脚本名发布已停用，请提供 releaseId"));
    const stage = String(body.stage || body.pushMode || "active");
    const rolloutPercent = stage === "active" ? 100 : Number(body.rolloutPercent ?? 10);
    try {
      const result = await publishScriptReleaseFn(releaseId, stage, rolloutPercent, request.adminUser || "admin");
      await recordPublishedIssue(result, request.adminUser || "admin");
      return apiOk({ ...result, promoted: true });
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.post("/api/v1/admin/scripts/releases/:id/rollback", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const releaseId = (request.params as { id: string }).id;
    try {
      const result = await rollbackScriptReleaseFn(releaseId, request.adminUser || "admin");
      await recordRolledBackIssue(result, request.adminUser || "admin");
      pushAdminLog("warning", "script release rolled back", { source: "script-release", actor: request.adminUser || "admin", releaseId, parentReleaseId: result.parentReleaseId });
      return apiOk({ ...result, rolledBack: true });
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.post("/api/v1/admin/rollback_script", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const body = (request.body || {}) as Record<string, string>;
    const releaseId = String(body.releaseId || "");
    if (!releaseId) return reply.code(400).send(apiError(400, "旧版按脚本名回滚已停用，请提供 releaseId"));
    try {
      const result = await rollbackScriptReleaseFn(releaseId, request.adminUser || "admin");
      await recordRolledBackIssue(result, request.adminUser || "admin");
      return apiOk({ ...result, rolledBack: true });
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.post("/api/v1/admin/scripts/releases/:id/disable", { preHandler: authRequiredFn }, async (request: AdminRequest, reply) => {
    const releaseId = (request.params as { id: string }).id;
    const body = (request.body || {}) as Record<string, unknown>;
    try {
      const result = await disableScriptReleaseFn(releaseId, String(body.reason || ""), request.adminUser || "admin");
      if (result.issueId) {
        await setIssueStage(result.issueId, "DISABLED", "release disabled");
        await addIssueEvent({ issueId: result.issueId, stage: "DISABLED", actor: request.adminUser || "admin", message: `disabled ${releaseId}` });
      }
      return apiOk({ ...result, disabled: true });
    } catch (error) {
      return sendScriptReleaseError(reply, error);
    }
  });

  app.get("/api/v1/admin/script_history", { preHandler: authRequiredFn }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const scriptName = String(q.scriptName || q.script_name || "").trim();
    if (!scriptName) {
      return apiError(400, "缺少 scriptName");
    }
    const limit = Math.max(1, Math.min(500, Number(q.limit || 200)));
    const releases = await query(
      `SELECT
         r.release_id,
         r.name,
         r.version,
         r.release_stage,
         r.parent_release_id,
         pr.version AS parent_version,
         r.issue_id,
         r.changelog,
         r.created_at,
         r.approved_at,
         r.published_at,
         r.approved_by,
         a.created_by,
         i.school_id,
         i.school_name
       FROM script_releases r
       LEFT JOIN script_releases pr ON pr.release_id = r.parent_release_id
       LEFT JOIN script_artifacts a ON a.release_id = r.release_id
       LEFT JOIN repair_issues i ON i.issue_id = r.issue_id
       WHERE r.name = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [scriptName, limit]
    );
    const audits = await query(
      `SELECT
         al.actor,
         al.action,
         al.created_at AS audit_created_at,
         al.detail_json->>'stage' AS detail_stage,
         al.detail_json->>'parentReleaseId' AS detail_parent_release_id,
         r.release_id,
         r.name,
         r.version,
         r.release_stage,
         r.parent_release_id,
         pr.version AS parent_version,
         r.issue_id,
         r.approved_by,
         r.published_at,
         i.school_id,
         i.school_name
       FROM audit_logs al
       JOIN script_releases r ON r.release_id = al.target_id
       LEFT JOIN script_releases pr ON pr.release_id = r.parent_release_id
       LEFT JOIN repair_issues i ON i.issue_id = r.issue_id
       WHERE al.target_type = 'script_release'
         AND al.action IN ('publish_release', 'rollback_release')
         AND r.name = $1
       ORDER BY al.created_at DESC
       LIMIT $2`,
      [scriptName, Math.max(limit * 2, 20)]
    );
    const list = buildScriptHistoryEntries({
      scriptName,
      releaseRows: releases.rows as Array<Record<string, unknown>>,
      auditRows: audits.rows as Array<Record<string, unknown>>,
      limit
    });
    return apiOk({ list });
  });

  app.get("/api/v1/admin/runtime_logs", { preHandler: authRequiredFn }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const source = String(q.source || "all").trim() || "all";
    const limit = Math.max(1, Math.min(20000, Number(q.limit || 1000)));
    const payload = await loadRuntimeLogsPayload(source, limit);
    return apiOk(payload);
  });
}

type AdminUserRow = {
  username: string;
  password_hash: string;
  password_salt: string;
  is_builtin: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  last_login_at: Date | string | null;
};

function hashAdminPassword(password: string, salt: string): string {
  return sha256(`${salt}:${password}`);
}

async function ensureBuiltinAdminUser(): Promise<void> {
  const username = config.adminUsername.trim();
  if (!username) return;
  const existing = await findAdminUser(username);
  if (existing) return;
  const salt = id("salt");
  await query(
    `INSERT INTO admin_users(username, password_hash, password_salt, is_builtin)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (username) DO NOTHING`,
    [username, hashAdminPassword(config.adminPassword, salt), salt]
  );
}

async function findAdminUser(username: string): Promise<{
  username: string;
  passwordHash: string;
  passwordSalt: string;
  isBuiltin: boolean;
} | null> {
  const normalized = username.trim();
  if (!normalized) return null;
  const result = await query<AdminUserRow>(
    "SELECT username, password_hash, password_salt, is_builtin, created_at, updated_at, last_login_at FROM admin_users WHERE username = $1",
    [normalized]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    isBuiltin: Boolean(row.is_builtin)
  };
}

async function touchAdminUserLogin(username: string): Promise<void> {
  const normalized = username.trim();
  if (!normalized) return;
  await query("UPDATE admin_users SET last_login_at = now(), updated_at = now() WHERE username = $1", [normalized]);
}

async function listAdminUsers(): Promise<Array<Record<string, unknown>>> {
  await ensureBuiltinAdminUser();
  const result = await query<AdminUserRow>(
    `SELECT username, password_hash, password_salt, is_builtin, created_at, updated_at, last_login_at
     FROM admin_users
     ORDER BY is_builtin DESC, created_at ASC`
  );
  return result.rows.map((row) => ({
    username: row.username,
    isBuiltin: Boolean(row.is_builtin),
    createdAt: row.created_at ? new Date(String(row.created_at)).getTime() : 0,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).getTime() : 0,
    lastLoginAt: row.last_login_at ? new Date(String(row.last_login_at)).getTime() : 0
  }));
}

async function createAdminUser(username: string, password: string): Promise<{ ok: boolean; code: number; msg: string }> {
  const normalized = username.trim();
  if (!normalized) return { ok: false, code: 400, msg: "账号不能为空" };
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(normalized)) {
    return { ok: false, code: 400, msg: "账号仅支持 3-32 位字母、数字、下划线、点和横杠" };
  }
  if (password.trim().length < 4) {
    return { ok: false, code: 400, msg: "密码至少 4 位" };
  }
  const existing = await findAdminUser(normalized);
  if (existing) return { ok: false, code: 409, msg: "账号已存在" };
  const salt = id("salt");
  await query(
    `INSERT INTO admin_users(username, password_hash, password_salt, is_builtin, created_at, updated_at)
     VALUES ($1,$2,$3,false,now(),now())`,
    [normalized, hashAdminPassword(password, salt), salt]
  );
  return { ok: true, code: 200, msg: "ok" };
}

async function renameAdminUser(oldUsername: string, newUsername: string): Promise<{ ok: boolean; code: number; msg: string }> {
  const oldName = oldUsername.trim();
  const nextName = newUsername.trim();
  if (!oldName || !nextName) return { ok: false, code: 400, msg: "账号不能为空" };
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(nextName)) {
    return { ok: false, code: 400, msg: "新账号仅支持 3-32 位字母、数字、下划线、点和横杠" };
  }
  const target = await findAdminUser(oldName);
  if (!target) return { ok: false, code: 404, msg: "账号不存在" };
  if (target.isBuiltin) return { ok: false, code: 400, msg: "内置管理员账号不允许改名" };
  const duplicate = await findAdminUser(nextName);
  if (duplicate) return { ok: false, code: 409, msg: "新账号已存在" };
  await query("UPDATE admin_users SET username = $2, updated_at = now() WHERE username = $1", [oldName, nextName]);
  await query("UPDATE admin_sessions SET username = $2 WHERE username = $1", [oldName, nextName]);
  return { ok: true, code: 200, msg: "ok" };
}

async function updateAdminUserPassword(username: string, newPassword: string): Promise<{ ok: boolean; code: number; msg: string }> {
  const normalized = username.trim();
  if (!normalized) return { ok: false, code: 400, msg: "账号不能为空" };
  if (newPassword.trim().length < 4) return { ok: false, code: 400, msg: "密码至少 4 位" };
  const target = await findAdminUser(normalized);
  if (!target) return { ok: false, code: 404, msg: "账号不存在" };
  const salt = id("salt");
  await query("UPDATE admin_users SET password_hash = $2, password_salt = $3, updated_at = now() WHERE username = $1", [
    normalized,
    hashAdminPassword(newPassword, salt),
    salt
  ]);
  return { ok: true, code: 200, msg: "ok" };
}

async function deleteAdminUser(username: string, actor: string): Promise<{ ok: boolean; code: number; msg: string }> {
  const normalized = username.trim();
  if (!normalized) return { ok: false, code: 400, msg: "账号不能为空" };
  if (normalized === actor.trim()) return { ok: false, code: 400, msg: "不允许删除当前登录账号" };
  const target = await findAdminUser(normalized);
  if (!target) return { ok: false, code: 404, msg: "账号不存在" };
  if (target.isBuiltin) return { ok: false, code: 400, msg: "内置管理员账号不允许删除" };
  await query("DELETE FROM admin_sessions WHERE username = $1", [normalized]);
  await query("DELETE FROM admin_users WHERE username = $1", [normalized]);
  return { ok: true, code: 200, msg: "ok" };
}

async function authOptional(request: AdminRequest): Promise<void> {
  const token = getBearer(request);
  if (!token) return;
  const session = await query<{ username: string }>("SELECT username FROM admin_sessions WHERE token = $1 AND expires_at > now()", [token]);
  if (session.rows[0]) request.adminUser = session.rows[0].username;
}

async function authRequired(request: AdminRequest, reply: FastifyReply): Promise<void> {
  await authOptional(request);
  if (!request.adminUser) {
    reply.code(401).send(apiError(401, "登录状态已失效，请重新登录"));
  }
}

function getBearer(request: FastifyRequest): string {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function cleanupEventStreamTokens(): void {
  const now = Date.now();
  for (const [token, info] of eventStreamTokens.entries()) {
    if (info.expiresAt <= now) eventStreamTokens.delete(token);
  }
}

/**
 * 写入管理后台内存日志缓冲区。
 * 该缓冲区是 `runtime_logs?source=admin` 的数据来源，同时也会参与“全部来源”聚合。
 */
function pushAdminLog(level: string, message: string, extra: Record<string, unknown> = {}): void {
  adminLogBuffer.push({
    id: id("admin_log"),
    level,
    message,
    extra,
    createdAt: Date.now()
  });
  if (adminLogBuffer.length > config.adminLogBufferLimit) {
    adminLogBuffer.splice(0, adminLogBuffer.length - config.adminLogBufferLimit);
  }
}

/**
 * 从文件尾部读取指定行数。
 * 只读取最后一个窗口的字节，避免大日志文件被一次性全部读入内存。
 */
async function readTailLinesFromFile(filePath: string, maxLines: number): Promise<{ lines: string[]; exists: boolean }> {
  if (!filePath) return { lines: [], exists: false };
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return { lines: [], exists: false };
    if (stats.size <= 0) return { lines: [], exists: true };
    const readBytes = Math.min(stats.size, config.runtimeLogReadBytes);
    const handle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, stats.size - readBytes);
      const lines = buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-maxLines);
      return { lines, exists: true };
    } finally {
      await handle.close();
    }
  } catch {
    return { lines: [], exists: false };
  }
}

/**
 * 组装运行日志页的统一响应。
 * 兼容旧版 Node 实现的字段集合，保证当前 `admin.js` 可直接消费。
 */
async function loadRuntimeLogsPayload(source: string, limit: number) {
  const files: Record<RuntimeLogSourceKey, string> = {
    backend: config.backendMirrorLogFile,
    nginx_access: config.nginxAccessLogFile,
    nginx_error: config.nginxErrorLogFile,
    admin: "adminLogBuffer"
  };
  const memoryLines = adminLogBuffer.slice(-limit).map((item) => formatAdminBufferLine(item));
  if (source === "admin") {
    return buildRuntimeLogPayload({
      requestedSource: source,
      resolvedSource: "admin",
      requestedLimit: limit,
      files,
      lines: memoryLines,
      sourceCounts: { admin: memoryLines.length },
      missingSources: []
    });
  }
  if (source === "backend" || source === "nginx_access" || source === "nginx_error") {
    const result = await readTailLinesFromFile(files[source], limit);
    return buildRuntimeLogPayload({
      requestedSource: source,
      resolvedSource: source,
      requestedLimit: limit,
      files,
      lines: result.lines,
      sourceCounts: { [source]: result.lines.length },
      missingSources: result.exists ? [] : [source]
    });
  }
  const backendResult = await readTailLinesFromFile(files.backend, limit);
  const accessResult = await readTailLinesFromFile(files.nginx_access, limit);
  const errorResult = await readTailLinesFromFile(files.nginx_error, limit);
  const missingSources: string[] = [];
  if (!backendResult.exists) missingSources.push("backend");
  if (!accessResult.exists) missingSources.push("nginx_access");
  if (!errorResult.exists) missingSources.push("nginx_error");
  const lines = [
    ...backendResult.lines.map((line) => `[backend] ${line}`),
    ...accessResult.lines.map((line) => `[nginx-access] ${line}`),
    ...errorResult.lines.map((line) => `[nginx-error] ${line}`),
    ...memoryLines.map((line) => `[admin-buffer] ${line}`)
  ];
  return buildRuntimeLogPayload({
    requestedSource: source,
    resolvedSource: "all",
    requestedLimit: limit,
    files,
    lines,
    sourceCounts: {
      backend: backendResult.lines.length,
      nginx_access: accessResult.lines.length,
      nginx_error: errorResult.lines.length,
      admin: memoryLines.length
    },
    missingSources
  });
}

async function loadAdminStats(): Promise<Record<string, unknown>> {
  const issues = await query("SELECT count(*)::int AS count FROM repair_issues");
  const sessions = await query("SELECT final_success, count(*)::int AS count FROM parse_sessions GROUP BY final_success");
  const scriptSessionFeedback = {
    totals: {
      successCount: Number(sessions.rows.find((row) => row.final_success === true)?.count || 0),
      failureCount: Number(sessions.rows.find((row) => row.final_success === false)?.count || 0)
    },
    bySystem: {},
    byFailureType: {},
    byScript: {}
  };
  const totals = scriptSessionFeedback.totals as Record<string, number>;
  totals.totalCount = totals.successCount + totals.failureCount;
  totals.successRate = totals.totalCount > 0 ? totals.successCount / totals.totalCount : 0;
  return {
    serverStartedAt: Date.now(),
    latestMetricsAt: Date.now(),
    metricsFile: config.metricsFile,
    repairIssueCount: Number(issues.rows[0]?.count || 0),
    schools: {},
    failures: [],
    scriptParseFeedback: {},
    scriptSessionFeedback,
    sessionScriptAnalytics: scriptSessionFeedback
  };
}

async function loadModelConfig(): Promise<Record<string, unknown>> {
  return getAdminConfigPayload();
}

/** 同步自动修复问题的发布阶段。 */
async function recordPublishedIssue(result: ScriptReleaseAdminResult, actor: string): Promise<void> {
  if (!result.issueId) return;
  const stage = result.releaseStage === "active" ? "ACTIVE" : "CANARY";
  await setIssueStage(result.issueId, stage, `published ${result.releaseStage}`);
  await addIssueEvent({ issueId: result.issueId, stage, actor, message: `published ${result.releaseId} to ${result.releaseStage}` });
}

/** 同步自动修复问题的回滚阶段。 */
async function recordRolledBackIssue(result: ScriptReleaseAdminResult, actor: string): Promise<void> {
  if (!result.issueId) return;
  await setIssueStage(result.issueId, "ROLLED_BACK", "rolled back");
  await addIssueEvent({ issueId: result.issueId, stage: "ROLLED_BACK", actor, message: `rolled back ${result.releaseId}` });
}

/** 将发布服务错误映射为稳定的管理 API HTTP 状态。 */
function sendScriptReleaseError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "release_not_found") return reply.code(404).send(apiError(404, "脚本版本不存在"));
  if (code === "release_not_validated" || code === "rollback_parent_scope_mismatch") {
    return reply.code(409).send(apiError(409, code));
  }
  return reply.code(400).send(apiError(400, code));
}

function formatIssue(row: Record<string, unknown>): Record<string, unknown> {
  const blockedReason = getAutoRepairBlockedReason({
    repair_domain: String(row.repair_domain || ""),
    target_type: String(row.target_type || "") as any
  });
  const repairWorkflow = resolveScriptRepairWorkflow({
    repairDomain: String(row.repair_domain || ""),
    targetType: String(row.target_type || ""),
    category: String(row.affected_category || "")
  });
  const rawStage = String(row.current_stage || "");
  const stageNeedsDowngrade =
    blockedReason &&
    !["", "REPORTED", "CLASSIFIED", "ISSUE_MERGED"].includes(rawStage);
  const effectiveStage = stageNeedsDowngrade ? "ISSUE_MERGED" : rawStage;
  return {
    issueId: row.issue_id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    schoolSystemType: row.school_system_type,
    sourceUrlHost: row.source_url_host,
    repairDomain: row.repair_domain,
    targetType: row.target_type,
    scriptRepairWorkflow: repairWorkflow,
    scriptRepairWorkflowLabel: formatScriptRepairWorkflowLabel(repairWorkflow),
    scriptRepairWorkflowDescription: describeScriptRepairWorkflow(repairWorkflow),
    affectedScriptId: row.affected_script_name || row.affected_script_id,
    affectedVersion: row.affected_version,
    failureType: row.failure_type,
    status: row.status,
    currentStage: effectiveStage,
    autoRepairBlockedReason: blockedReason || "",
    priority: row.priority,
    sampleCount: row.sample_count,
    userCount: row.user_count,
    lastErrorMessage: blockedReason || row.last_error,
    lastResult: row.last_result,
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0,
    lastStepAt: row.last_step_at ? new Date(String(row.last_step_at)).getTime() : 0,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).getTime() : 0,
    lastParserName: row.affected_script_name,
    lastParserVersion: row.affected_version,
    lastScriptSource: "registry"
  };
}

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    stepId: row.id,
    ts: row.created_at ? new Date(String(row.created_at)).getTime() : Date.now(),
    stage: row.stage,
    level: row.level,
    message: row.message,
    actor: row.actor,
    source: row.source,
    durationMs: row.duration_ms || 0,
    meta: row.meta_json || {}
  };
}

function formatRelease(row: Record<string, unknown>): Record<string, unknown> {
  const repairWorkflow = resolveScriptRepairWorkflow({
    targetType: String(row.target_type || ""),
    category: String(row.category || "")
  });
  const releaseStage = String(row.release_stage || "");
  const parentVersion = Number(row.parent_version || 0);
  const updatedAt = row.published_at || row.created_at;
  const activation = {
    verified: Number(row.verified_count || 0),
    trialPassed: Number(row.trial_passed_count || 0),
    activated: Number(row.activated_count || 0),
    failed: Number(row.failed_count || 0),
    quarantined: Number(row.quarantined_count || 0),
    rolledBack: Number(row.rolled_back_count || 0)
  };
  return {
    releaseId: row.release_id,
    scriptId: row.script_id,
    scriptKey: row.script_key,
    targetType: row.target_type,
    category: row.category,
    scriptRepairWorkflow: repairWorkflow,
    scriptRepairWorkflowLabel: formatScriptRepairWorkflowLabel(repairWorkflow),
    scriptRepairWorkflowDescription: describeScriptRepairWorkflow(repairWorkflow),
    name: row.name,
    scriptName: row.name,
    version: row.version,
    parentReleaseId: row.parent_release_id || "",
    parentVersion,
    releaseStage,
    channel: row.channel,
    status: row.status,
    rolloutPercent: row.rollout_percent,
    killSwitch: row.kill_switch,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    schoolSystemType: row.school_system_type,
    validationStatus: row.validation_status,
    validationReport: row.validation_report_json || {},
    parserApiVersion: row.parser_api_version,
    runnerContractVersion: row.runner_contract_version,
    sha256: row.content_sha256,
    signatureReady: Boolean(row.signature),
    issueId: row.issue_id,
    updatedAt,
    appliedBy: row.approved_by || row.created_by || "",
    pendingAvailable: releaseStage === "pending" && String(row.validation_status || "") === "passed",
    rollbackAvailable: Boolean(row.parent_release_id && parentVersion > 0),
    rollbackTargetVersion: parentVersion,
    activation,
    meta: {
      scriptName: row.name,
      targetType: row.target_type,
      category: row.category,
      version: Number(row.version || 0),
      parentVersion,
      releaseStage,
      updatedAt: updatedAt ? new Date(String(updatedAt)).getTime() : 0,
      appliedBy: row.approved_by || row.created_by || ""
    }
  };
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiOk(data: unknown): { code: number; msg: string; data: unknown } {
  return { code: 200, msg: "ok", data };
}

function apiError(code: number, msg: string): { code: number; msg: string; data: null } {
  return { code, msg, data: null };
}
