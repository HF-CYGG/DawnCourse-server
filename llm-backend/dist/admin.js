import fs from "node:fs";
import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { chatCompletionsUrl, runReplayOnly, startRepairJob } from "./repair.js";
import { getAdminConfigPayload } from "./runtimeConfig.js";
import { limitString, id } from "./utils.js";
export async function registerAdminRoutes(app) {
    app.post("/api/v1/admin/login", async (request) => {
        const body = (request.body || {});
        if (body.username !== config.adminUsername || body.password !== config.adminPassword) {
            return { code: 401, msg: "invalid credentials", data: null };
        }
        const token = id("adm");
        const expiresAt = new Date(Date.now() + config.adminSessionTtlMs);
        await query("INSERT INTO admin_sessions(token, username, expires_at) VALUES ($1,$2,$3)", [token, body.username, expiresAt]);
        return apiOk({ token, username: body.username, expiresAt: expiresAt.getTime() });
    });
    app.get("/api/v1/admin/session", { preHandler: authOptional }, async (request) => {
        return apiOk({ authenticated: Boolean(request.adminUser), username: request.adminUser || "" });
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
        await query(`INSERT INTO system_config(key, value_json) VALUES ('model_config',$1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()`, [JSON.stringify(body)]);
        return apiOk({ saved: true });
    });
    app.post("/api/v1/admin/config/test", { preHandler: authRequired }, async (request) => {
        const started = Date.now();
        const body = (request.body || {});
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
        }
        catch (error) {
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
        }
        finally {
            clearTimeout(timer);
        }
    });
    app.get("/api/v1/admin/repair/issues", { preHandler: authRequired }, async () => {
        const rows = await query(`SELECT i.*, e.created_at AS last_step_at
       FROM repair_issues i
       LEFT JOIN LATERAL (
         SELECT created_at FROM repair_issue_events e WHERE e.issue_id = i.issue_id ORDER BY created_at DESC LIMIT 1
       ) e ON true
       ORDER BY i.last_seen_at DESC LIMIT 200`);
        return apiOk({ list: rows.rows.map(formatIssue) });
    });
    app.get("/api/v1/admin/repair/issues/:id", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const issue = await query("SELECT * FROM repair_issues WHERE issue_id = $1", [issueId]);
        const samples = await query("SELECT sample_id, content_sha256, sanitizer_version, created_at, left(sanitized_content, 5000) AS preview FROM failure_samples WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20", [issueId]);
        const reports = await query("SELECT * FROM runner_reports WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20", [issueId]);
        const jobs = await query("SELECT * FROM repair_jobs WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 20", [issueId]);
        return apiOk({ issue: issue.rows[0] ? formatIssue(issue.rows[0]) : null, samples: samples.rows, reports: reports.rows, jobs: jobs.rows });
    });
    app.get("/api/v1/admin/repair/issues/:id/timeline", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const rows = await query("SELECT * FROM repair_issue_events WHERE issue_id = $1 ORDER BY created_at ASC LIMIT 300", [issueId]);
        return apiOk({ list: rows.rows.map(formatEvent) });
    });
    app.get("/api/v1/admin/repair/issues/:id/logs", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const q = request.query;
        const stage = q.stage || "";
        const level = q.level || "";
        const rows = await query(`SELECT * FROM repair_issue_events
       WHERE issue_id = $1 AND ($2 = '' OR stage = $2) AND ($3 = '' OR level = $3)
       ORDER BY created_at DESC LIMIT 300`, [issueId, stage, level]);
        return apiOk({ list: rows.rows.map(formatEvent) });
    });
    app.post("/api/v1/admin/repair/issues/:id/run-test", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const result = await runReplayOnly(issueId, request.adminUser || "admin");
        return apiOk({ ...result, testedBy: request.adminUser || "admin" });
    });
    app.post("/api/v1/admin/repair/issues/:id/retry", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: false });
        return apiOk(result);
    });
    app.post("/api/v1/admin/repair/issues/:id/force-repair", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        await addIssueEvent({ issueId, stage: "SAMPLE_READY", actor: request.adminUser || "admin", source: "admin_force_repair", message: "管理员立即修复，忽略最小样本数限制" });
        const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
        return apiOk(result);
    });
    app.post("/api/v1/admin/repair/issues/:id/run", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        const result = await startRepairJob(issueId, { actor: request.adminUser || "admin", bypassMinQueue: true });
        return apiOk(result);
    });
    app.post("/api/v1/admin/repair/issues/:id/delete", { preHandler: authRequired }, async (request) => {
        const issueId = request.params.id;
        await query("DELETE FROM repair_issue_events WHERE issue_id = $1", [issueId]);
        await query("DELETE FROM failure_samples WHERE issue_id = $1", [issueId]);
        await query("DELETE FROM runner_reports WHERE issue_id = $1", [issueId]);
        await query("DELETE FROM repair_jobs WHERE issue_id = $1", [issueId]);
        await query("DELETE FROM repair_issues WHERE issue_id = $1", [issueId]);
        return apiOk({ deleted: true });
    });
    app.get("/api/v1/admin/scripts", { preHandler: authRequired }, async () => {
        const rows = await query(`SELECT r.*, a.content_sha256, a.signature
       FROM script_releases r JOIN script_artifacts a ON a.script_id = r.script_id AND a.version = r.version
       ORDER BY r.created_at DESC LIMIT 300`);
        return apiOk({ list: rows.rows.map(formatRelease) });
    });
    app.get("/api/v1/admin/script_content", { preHandler: authRequired }, async (request) => {
        const q = request.query;
        const row = await query("SELECT content FROM script_artifacts WHERE name = $1 ORDER BY version DESC LIMIT 1", [q.scriptName || q.name || ""]);
        return apiOk({ content: row.rows[0]?.content || "" });
    });
    app.post("/api/v1/admin/scripts/releases", { preHandler: authRequired }, async (request) => {
        const body = (request.body || {});
        const releaseId = String(body.releaseId || "");
        const targetStage = String(body.releaseStage || body.stage || "canary");
        if (!releaseId)
            return { code: 400, msg: "missing releaseId", data: null };
        await publishRelease(releaseId, targetStage, request.adminUser || "admin");
        return apiOk({ releaseId, releaseStage: targetStage });
    });
    app.post("/api/v1/admin/promote_script", { preHandler: authRequired }, async (request) => {
        const body = (request.body || {});
        const releaseId = String(body.releaseId || "");
        if (releaseId)
            await publishRelease(releaseId, String(body.stage || "active"), request.adminUser || "admin");
        return apiOk({ promoted: Boolean(releaseId), releaseId });
    });
    app.post("/api/v1/admin/scripts/releases/:id/rollback", { preHandler: authRequired }, async (request) => {
        const releaseId = request.params.id;
        await rollbackRelease(releaseId, request.adminUser || "admin");
        return apiOk({ rolledBack: true });
    });
    app.post("/api/v1/admin/rollback_script", { preHandler: authRequired }, async (request) => {
        const body = (request.body || {});
        const row = await query("SELECT release_id FROM script_releases WHERE name = $1 AND release_stage = 'active' ORDER BY version DESC LIMIT 1", [body.scriptName || ""]);
        if (row.rows[0]?.release_id)
            await rollbackRelease(String(row.rows[0].release_id), request.adminUser || "admin");
        return apiOk({ rolledBack: Boolean(row.rows[0]) });
    });
    app.get("/api/v1/admin/runtime_logs", { preHandler: authRequired }, async (request) => {
        const q = request.query;
        const limit = Math.min(Number(q.limit || 500), 1000);
        const file = config.backendMirrorLogFile;
        const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-limit).join("\n") : "";
        return apiOk({ source: q.source || "backend", list: text ? text.split(/\r?\n/).filter(Boolean) : [], text });
    });
}
async function authOptional(request) {
    const token = getBearer(request);
    if (!token)
        return;
    const session = await query("SELECT username FROM admin_sessions WHERE token = $1 AND expires_at > now()", [token]);
    if (session.rows[0])
        request.adminUser = session.rows[0].username;
}
async function authRequired(request, reply) {
    await authOptional(request);
    if (!request.adminUser) {
        reply.code(401).send({ code: 401, msg: "unauthorized", data: null });
    }
}
function getBearer(request) {
    const header = request.headers.authorization || "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
}
async function loadAdminStats() {
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
    const totals = scriptSessionFeedback.totals;
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
async function loadModelConfig() {
    return getAdminConfigPayload();
}
async function publishRelease(releaseId, stage, actor) {
    const release = await query("SELECT script_id, issue_id FROM script_releases WHERE release_id = $1", [releaseId]);
    const row = release.rows[0];
    if (!row)
        throw new Error("release_not_found");
    if (stage === "active") {
        await query("UPDATE script_releases SET release_stage = 'rolled_back' WHERE script_id = $1 AND release_stage = 'active'", [row.script_id]);
    }
    await query("UPDATE script_releases SET release_stage = $2, channel = $2, rollout_percent = CASE WHEN $2 = 'active' THEN 100 ELSE rollout_percent END, approved_by = $3, approved_at = now(), published_at = now() WHERE release_id = $1", [releaseId, stage, actor]);
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
async function rollbackRelease(releaseId, actor) {
    const release = await query("SELECT script_id, parent_release_id, issue_id FROM script_releases WHERE release_id = $1", [releaseId]);
    const row = release.rows[0];
    if (!row)
        throw new Error("release_not_found");
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
function formatIssue(row) {
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
function formatEvent(row) {
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
function formatRelease(row) {
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
function safeParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function apiOk(data) {
    return { code: 200, msg: "ok", data };
}
