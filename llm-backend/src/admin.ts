import fs from "node:fs";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { chatCompletionsUrl, runReplayOnly, startRepairJob } from "./repair.js";
import { getAdminConfigPayload } from "./runtimeConfig.js";
import { log } from "./log.js";
import { limitString, id, sha256 } from "./utils.js";

type AdminRequest = FastifyRequest & { adminUser?: string };
const eventStreamTokens = new Map<string, { username: string; expiresAt: number }>();

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await ensureBuiltinAdminUser();

  app.post("/api/v1/admin/login", async (request) => {
    const body = (request.body || {}) as Record<string, string>;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const target = await findAdminUser(username);
    if (!target || hashAdminPassword(password, target.passwordSalt) !== target.passwordHash) {
      return { code: 401, msg: "invalid credentials", data: null };
    }
    const token = id("adm");
    const expiresAt = new Date(Date.now() + config.adminSessionTtlMs);
    await query("INSERT INTO admin_sessions(token, username, expires_at) VALUES ($1,$2,$3)", [token, username, expiresAt]);
    await touchAdminUserLogin(username);
    return apiOk({ token, username, expiresAt: expiresAt.getTime() });
  });

  app.get("/api/v1/admin/session", { preHandler: authRequired }, async (request: AdminRequest) => {
    return apiOk({ authenticated: true, username: request.adminUser || "" });
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/v1/admin/logout",
    preHandler: authRequired,
    handler: async (request: AdminRequest) => {
      const token = getBearer(request);
      if (token) await query("DELETE FROM admin_sessions WHERE token = $1", [token]);
      return apiOk({ loggedOut: true });
    }
  });

  app.get("/api/v1/admin/users", { preHandler: authRequired }, async () => {
    await ensureBuiltinAdminUser();
    return apiOk({ list: await listAdminUsers() });
  });

  app.post("/api/v1/admin/users", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const result = await createAdminUser(username, password);
    if (!result.ok) {
      return { code: result.code, msg: result.msg, data: null };
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "create_admin_user",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    return apiOk({ created: true, username });
  });

  app.post("/api/v1/admin/users/rename", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const oldUsername = String(body.oldUsername || "").trim();
    const newUsername = String(body.newUsername || "").trim();
    const result = await renameAdminUser(oldUsername, newUsername);
    if (!result.ok) {
      return { code: result.code, msg: result.msg, data: null };
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "rename_admin_user",
      "admin_user",
      oldUsername,
      JSON.stringify({ oldUsername, newUsername })
    ]);
    return apiOk({ renamed: true, oldUsername, newUsername });
  });

  app.post("/api/v1/admin/users/password", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const newPassword = String(body.newPassword || "").trim();
    const result = await updateAdminUserPassword(username, newPassword);
    if (!result.ok) {
      return { code: result.code, msg: result.msg, data: null };
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      request.adminUser || "admin",
      "reset_admin_user_password",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    return apiOk({ updated: true, username });
  });

  app.post("/api/v1/admin/users/delete", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const actor = request.adminUser || "admin";
    const result = await deleteAdminUser(username, actor);
    if (!result.ok) {
      return { code: result.code, msg: result.msg, data: null };
    }
    await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,$2,$3,$4,$5::jsonb)", [
      actor,
      "delete_admin_user",
      "admin_user",
      username,
      JSON.stringify({ username })
    ]);
    return apiOk({ deleted: true, username });
  });

  app.post("/api/v1/admin/events/token", { preHandler: authRequired }, async (request: AdminRequest) => {
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
      return reply.code(401).send({ code: 401, msg: "unauthorized", data: null });
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

  app.post("/api/v1/admin/client_error", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    log.warn("admin client error", {
      actor: request.adminUser || "admin",
      message: limitString(String(body.message || ""), 300),
      stack: limitString(String(body.stack || ""), 1000)
    });
    return apiOk({ accepted: true });
  });

  app.get("/api/v1/admin/data", { preHandler: authRequired }, async () => {
    const stats = await loadAdminStats();
    return apiOk(stats);
  });

  app.get("/api/v1/admin/config", { preHandler: authRequired }, async () => {
    return apiOk(await loadModelConfig());
  });

  app.post("/api/v1/admin/config", { preHandler: authRequired }, async (request) => {
    const body = request.body || {};
    await query(
      `INSERT INTO system_config(key, value_json) VALUES ('model_config',$1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()`,
      [JSON.stringify(body)]
    );
    return apiOk({ saved: true });
  });

  app.post("/api/v1/admin/config/test", { preHandler: authRequired }, async (request) => {
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

  app.get("/api/v1/admin/repair/issues", { preHandler: authRequired }, async () => {
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

  app.get("/api/v1/admin/repair/issues/:id", { preHandler: authRequired }, async (request) => {
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

  app.get("/api/v1/admin/repair/issues/:id/timeline", { preHandler: authRequired }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    const rows = await query(
      "SELECT * FROM repair_issue_events WHERE issue_id = $1 ORDER BY created_at ASC LIMIT 300",
      [issueId]
    );
    return apiOk({ list: rows.rows.map(formatEvent) });
  });

  app.get("/api/v1/admin/repair/issues/:id/logs", { preHandler: authRequired }, async (request) => {
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

  app.post("/api/v1/admin/repair/issues/:id/run-test", { preHandler: authRequired }, async (request: AdminRequest) => {
    const issueId = (request.params as { id: string }).id;
    const result = await runReplayOnly(issueId, request.adminUser || "admin");
    return apiOk({ ...result, testedBy: request.adminUser || "admin" });
  });

  app.post("/api/v1/admin/repair/issues/:id/retry", { preHandler: authRequired }, async (request: AdminRequest) => {
    const issueId = (request.params as { id: string }).id;
    const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: false });
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/force-repair", { preHandler: authRequired }, async (request: AdminRequest) => {
    const issueId = (request.params as { id: string }).id;
    await addIssueEvent({ issueId, stage: "SAMPLE_READY", actor: request.adminUser || "admin", source: "admin_force_repair", message: "管理员立即修复，忽略最小样本数限制" });
    const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/run", { preHandler: authRequired }, async (request: AdminRequest) => {
    const issueId = (request.params as { id: string }).id;
    const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
    return apiOk(result);
  });

  app.post("/api/v1/admin/repair/issues/:id/delete", { preHandler: authRequired }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    await query("DELETE FROM repair_issue_events WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM failure_samples WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM runner_reports WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM repair_jobs WHERE issue_id = $1", [issueId]);
    await query("DELETE FROM repair_issues WHERE issue_id = $1", [issueId]);
    return apiOk({ deleted: true });
  });

  app.get("/api/v1/admin/scripts", { preHandler: authRequired }, async () => {
    const rows = await query(
      `SELECT r.*, a.content_sha256, a.signature
       FROM script_releases r JOIN script_artifacts a ON a.script_id = r.script_id AND a.version = r.version
       ORDER BY r.created_at DESC LIMIT 300`
    );
    return apiOk({ list: rows.rows.map(formatRelease) });
  });

  app.get("/api/v1/admin/script_content", { preHandler: authRequired }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const row = await query("SELECT content FROM script_artifacts WHERE name = $1 ORDER BY version DESC LIMIT 1", [q.scriptName || q.name || ""]);
    return apiOk({ content: row.rows[0]?.content || "" });
  });

  app.post("/api/v1/admin/scripts/releases", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const releaseId = String(body.releaseId || "");
    const targetStage = String(body.releaseStage || body.stage || "canary");
    if (!releaseId) return { code: 400, msg: "missing releaseId", data: null };
    await publishRelease(releaseId, targetStage, request.adminUser || "admin");
    return apiOk({ releaseId, releaseStage: targetStage });
  });

  app.post("/api/v1/admin/promote_script", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const releaseId = String(body.releaseId || "");
    if (releaseId) await publishRelease(releaseId, String(body.stage || "active"), request.adminUser || "admin");
    return apiOk({ promoted: Boolean(releaseId), releaseId });
  });

  app.post("/api/v1/admin/scripts/releases/:id/rollback", { preHandler: authRequired }, async (request: AdminRequest) => {
    const releaseId = (request.params as { id: string }).id;
    await rollbackRelease(releaseId, request.adminUser || "admin");
    return apiOk({ rolledBack: true });
  });

  app.post("/api/v1/admin/rollback_script", { preHandler: authRequired }, async (request: AdminRequest) => {
    const body = (request.body || {}) as Record<string, string>;
    const row = await query("SELECT release_id FROM script_releases WHERE name = $1 AND release_stage = 'active' ORDER BY version DESC LIMIT 1", [body.scriptName || ""]);
    if (row.rows[0]?.release_id) await rollbackRelease(String(row.rows[0].release_id), request.adminUser || "admin");
    return apiOk({ rolledBack: Boolean(row.rows[0]) });
  });

  app.get("/api/v1/admin/runtime_logs", { preHandler: authRequired }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit || 500), 1000);
    const file = config.backendMirrorLogFile;
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-limit).join("\n") : "";
    return apiOk({ source: q.source || "backend", list: text ? text.split(/\r?\n/).filter(Boolean) : [], text });
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
    reply.code(401).send({ code: 401, msg: "unauthorized", data: null });
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

async function publishRelease(releaseId: string, stage: string, actor: string): Promise<void> {
  const release = await query<{ script_id: string; issue_id: string | null }>("SELECT script_id, issue_id FROM script_releases WHERE release_id = $1", [releaseId]);
  const row = release.rows[0];
  if (!row) throw new Error("release_not_found");
  if (stage === "active") {
    await query("UPDATE script_releases SET release_stage = 'rolled_back' WHERE script_id = $1 AND release_stage = 'active'", [row.script_id]);
  }
  await query(
    "UPDATE script_releases SET release_stage = $2, channel = $2, rollout_percent = CASE WHEN $2 = 'active' THEN 100 ELSE rollout_percent END, approved_by = $3, approved_at = now(), published_at = now() WHERE release_id = $1",
    [releaseId, stage, actor]
  );
  await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,'publish_release','script_release',$2,$3::jsonb)", [
    actor,
    releaseId,
    JSON.stringify({ stage })
  ]);
  if (row.issue_id) {
    await setIssueStage(row.issue_id, stage === "active" ? "ACTIVE" : "CANARY", `published ${stage}`);
    await addIssueEvent({ issueId: row.issue_id, stage: stage === "active" ? "ACTIVE" : "CANARY", actor, message: `发布 ${releaseId} 到 ${stage}` });
  }
}

async function rollbackRelease(releaseId: string, actor: string): Promise<void> {
  const release = await query<{ script_id: string; parent_release_id: string | null; issue_id: string | null }>(
    "SELECT script_id, parent_release_id, issue_id FROM script_releases WHERE release_id = $1",
    [releaseId]
  );
  const row = release.rows[0];
  if (!row) throw new Error("release_not_found");
  await query("UPDATE script_releases SET release_stage = 'rolled_back' WHERE release_id = $1", [releaseId]);
  if (row.parent_release_id) {
    await query("UPDATE script_releases SET release_stage = 'active', channel = 'stable', rollout_percent = 100, status = 'enabled' WHERE release_id = $1", [
      row.parent_release_id
    ]);
  }
  await query("INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,'rollback_release','script_release',$2,$3::jsonb)", [
    actor,
    releaseId,
    JSON.stringify({ parentReleaseId: row.parent_release_id })
  ]);
  if (row.issue_id) {
    await setIssueStage(row.issue_id, "ROLLED_BACK", "rolled back");
    await addIssueEvent({ issueId: row.issue_id, stage: "ROLLED_BACK", actor, message: `已回滚 ${releaseId}` });
  }
}

function formatIssue(row: Record<string, unknown>): Record<string, unknown> {
  return {
    issueId: row.issue_id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    schoolSystemType: row.school_system_type,
    sourceUrlHost: row.source_url_host,
    repairDomain: row.repair_domain,
    targetType: row.target_type,
    affectedScriptId: row.affected_script_name || row.affected_script_id,
    affectedVersion: row.affected_version,
    failureType: row.failure_type,
    status: row.status,
    currentStage: row.current_stage,
    priority: row.priority,
    sampleCount: row.sample_count,
    userCount: row.user_count,
    lastErrorMessage: row.last_error,
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
  return {
    releaseId: row.release_id,
    scriptId: row.script_id,
    targetType: row.target_type,
    category: row.category,
    name: row.name,
    version: row.version,
    releaseStage: row.release_stage,
    channel: row.channel,
    status: row.status,
    rolloutPercent: row.rollout_percent,
    killSwitch: row.kill_switch,
    sha256: row.content_sha256,
    signatureReady: Boolean(row.signature),
    issueId: row.issue_id,
    updatedAt: row.published_at || row.created_at
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
