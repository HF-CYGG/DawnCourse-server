import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { getActiveScriptContent, createPendingRelease } from "./registry.js";
import { describeScriptRepairWorkflow, formatScriptRepairWorkflowLabel, resolveScriptRepairWorkflow } from "./repairWorkflow.js";
import { runScript } from "./runnerClient.js";
import { getRuntimeModelConfig, getRuntimePlatformConfig } from "./runtimeConfig.js";
import { id, limitString, scriptId } from "./utils.js";
/**
 * 自动修复适用性判断：
 * - 登录/验证码页面、非课表页面、以及没有明确脚本目标的问题，不应进入脚本自动修复流水线；
 * - 返回空字符串表示允许自动修复，返回非空字符串表示应直接阻止并给出用户可读原因。
 */
export function getAutoRepairBlockedReason(issue) {
    if (!issue)
        return "问题不存在";
    if (issue.target_type === "none")
        return "该失败类型不适合自动修脚本";
    if (issue.repair_domain === "LOGIN_OR_CAPTCHA" || issue.repair_domain === "NON_TIMETABLE_PAGE") {
        return "该失败类型不适合自动修脚本";
    }
    return "";
}
export async function startRepairJob(issueId, options = {}) {
    const issue = await loadIssue(issueId);
    const blockedReason = getAutoRepairBlockedReason(issue);
    if (blockedReason) {
        await addIssueEvent({
            issueId,
            stage: "ISSUE_MERGED",
            level: "warning",
            actor: options.actor || "system",
            message: blockedReason
        });
        await setIssueStage(issueId, "ISSUE_MERGED", "repair blocked", blockedReason);
        return { jobId: "", started: false, reason: blockedReason };
    }
    const lock = await query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`repair:${issueId}`]);
    if (!lock.rows[0]?.locked) {
        await addIssueEvent({ issueId, stage: "SAMPLE_READY", level: "warning", message: "已有修复任务正在运行", actor: options.actor || "system" });
        return { jobId: "", started: false };
    }
    const jobId = id("job");
    await query(`INSERT INTO repair_jobs(job_id, issue_id, status, bypass_min_queue, actor, started_at)
     VALUES ($1,$2,'running',$3,$4,now())`, [jobId, issueId, options.bypassMinQueue === true, options.actor || "system"]);
    void runRepairJob(issueId, jobId, options).finally(async () => {
        await query("SELECT pg_advisory_unlock(hashtext($1))", [`repair:${issueId}`]).catch(() => undefined);
    });
    return { jobId, started: true };
}
export async function runReplayOnly(issueId, actor = "admin") {
    const issue = await loadIssue(issueId);
    const sample = await loadSample(issueId);
    if (!issue || !sample)
        return { ok: false, reason: "missing_issue_or_sample" };
    const active = await getActiveScriptContent(issue.affected_category, issue.affected_script_name);
    if (!active)
        return { ok: false, reason: "missing_active_script" };
    await addIssueEvent({ issueId, stage: "REPLAY_BASELINE", actor, message: "开始基线回放", meta: { script: issue.affected_script_name } });
    const report = await runScript({
        scriptContent: active.content,
        sampleContent: sample.sanitized_content,
        targetType: issue.target_type,
        timeoutMs: config.runnerTimeoutMs
    });
    const reportId = await saveRunnerReport({ issueId, scriptId: issue.affected_script_id, releaseId: active.releaseId, sampleId: sample.sample_id, targetType: issue.target_type, report });
    const ok = !report.ok || !report.schemaValid || report.resultCount === 0;
    await addIssueEvent({
        issueId,
        stage: "REPLAY_BASELINE",
        level: ok ? "info" : "warning",
        actor,
        message: ok ? "基线失败已复现" : "基线未复现失败，暂不自动修复",
        meta: { reportId, report }
    });
    return { ok, reason: ok ? undefined : "baseline_not_reproduced", reportId };
}
async function runRepairJob(issueId, jobId, options) {
    const actor = options.actor || "system";
    try {
        const issue = await loadIssue(issueId);
        if (!issue)
            throw new Error("issue_not_found");
        const blockedReason = getAutoRepairBlockedReason(issue);
        if (blockedReason) {
            await failJob(jobId, issueId, blockedReason);
            return;
        }
        const runtime = await getRuntimePlatformConfig();
        if (!options.bypassMinQueue && Number(issue.sample_count || 0) < runtime.minQueueSize) {
            await addIssueEvent({ issueId, jobId, stage: "SAMPLE_READY", level: "info", actor, message: `样本数不足，等待 ${runtime.minQueueSize} 条样本` });
            await query("UPDATE repair_jobs SET status = 'waiting', finished_at = now() WHERE job_id = $1", [jobId]);
            return;
        }
        const sample = await loadSample(issueId);
        if (!sample?.sanitized_content) {
            await failJob(jobId, issueId, "缺少用户授权脱敏样本");
            return;
        }
        await setIssueStage(issueId, "REPLAY_BASELINE", "baseline replay running");
        await addIssueEvent({ issueId, jobId, stage: "REPLAY_BASELINE", actor, message: "开始复现旧脚本失败", meta: { targetType: issue.target_type } });
        const active = await getActiveScriptContent(issue.affected_category, issue.affected_script_name);
        if (!active) {
            await failJob(jobId, issueId, "找不到 active 基线脚本");
            return;
        }
        const baseline = await runScript({ scriptContent: active.content, sampleContent: sample.sanitized_content, targetType: issue.target_type, timeoutMs: config.runnerTimeoutMs });
        const baselineReportId = await saveRunnerReport({ issueId, jobId, scriptId: issue.affected_script_id, releaseId: active.releaseId, sampleId: sample.sample_id, targetType: issue.target_type, report: baseline });
        const reproduced = !baseline.ok || !baseline.schemaValid || baseline.resultCount === 0;
        await addIssueEvent({
            issueId,
            jobId,
            stage: "REPLAY_BASELINE",
            level: reproduced ? "info" : "warning",
            actor,
            message: reproduced ? "旧脚本失败已复现" : "旧脚本没有复现失败，停止自动修复",
            meta: { baselineReportId, baseline }
        });
        if (!reproduced) {
            await failJob(jobId, issueId, "baseline_not_reproduced");
            return;
        }
        await setIssueStage(issueId, "DIAGNOSED", "diagnosing");
        const diagnosis = await diagnose(issue, sample.sanitized_content, baseline.errorMessage || baseline.errorCode || "empty result");
        await addIssueEvent({ issueId, jobId, stage: "DIAGNOSED", actor, message: "已生成修复诊断", meta: { diagnosis: diagnosis.summary } });
        await setIssueStage(issueId, "PATCH_GENERATED", "generating candidate");
        const candidate = await generateCandidate(issue, active.content, sample.sanitized_content, diagnosis.summary);
        if (!candidate.script.trim()) {
            await failJob(jobId, issueId, candidate.error || "candidate_empty");
            return;
        }
        await addIssueEvent({ issueId, jobId, stage: "PATCH_GENERATED", actor, message: "候选脚本已生成", meta: { summary: candidate.summary } });
        await setIssueStage(issueId, "RUNNER_TESTED", "candidate test running");
        const candidateReport = await runScript({ scriptContent: candidate.script, sampleContent: sample.sanitized_content, targetType: issue.target_type, timeoutMs: Math.max(config.runnerTimeoutMs, 10000) });
        const candidateReportId = await saveRunnerReport({ issueId, jobId, scriptId: issue.affected_script_id, sampleId: sample.sample_id, targetType: issue.target_type, report: candidateReport });
        if (!candidateReport.ok || !candidateReport.schemaValid || candidateReport.resultCount <= 0) {
            await addIssueEvent({
                issueId,
                jobId,
                stage: "RUNNER_TESTED",
                level: "error",
                actor,
                message: "候选脚本未通过 Runner 测试",
                meta: { candidateReportId, candidateReport }
            });
            await failJob(jobId, issueId, candidateReport.errorMessage || candidateReport.errorCode || "candidate_invalid");
            return;
        }
        await addIssueEvent({ issueId, jobId, stage: "RUNNER_TESTED", actor, message: "候选脚本通过提交样本测试", meta: { candidateReportId } });
        await setIssueStage(issueId, "REGRESSION_TESTED", "regression tested");
        await addIssueEvent({ issueId, jobId, stage: "REGRESSION_TESTED", actor, message: "MVP 回归检查通过", meta: { strategy: "same issue sample replay" } });
        const releaseId = await createPendingRelease({
            issueId,
            scriptId: issue.affected_script_id || scriptId(issue.affected_category, issue.affected_script_name),
            targetType: issue.target_type,
            category: issue.affected_category,
            name: issue.affected_script_name,
            content: candidate.script,
            parentReleaseId: active.releaseId,
            changelog: `Auto repair from ${issueId}: ${candidate.summary || diagnosis.summary}`,
            testReportId: candidateReportId,
            actor
        });
        await query("UPDATE repair_jobs SET status = 'completed', finished_at = now(), meta_json = $2::jsonb WHERE job_id = $1", [
            jobId,
            JSON.stringify({ releaseId, candidateReportId, baselineReportId })
        ]);
    }
    catch (error) {
        await failJob(jobId, issueId, error instanceof Error ? error.message : String(error));
    }
}
async function diagnose(issue, sample, baselineError) {
    return {
        summary: `${issue.repair_domain} ${issue.affected_script_name} failed: ${limitString(baselineError, 160)}. Sample chars=${sample.length}.`
    };
}
async function generateCandidate(issue, oldScript, sample, diagnosis) {
    const cfg = await getRuntimeModelConfig("script");
    if (!cfg.apiKey || !cfg.model) {
        return { script: "", summary: "model not configured", error: "script_repair_model_not_configured" };
    }
    const workflow = resolveScriptRepairWorkflow({
        repairDomain: issue.repair_domain,
        targetType: issue.target_type,
        category: issue.affected_category
    });
    const contract = workflow === "manual_capture"
        ? "This is a manual fixed-page timetable parser. Do not add login, redirect, captcha or page navigation logic. The script must expose scheduleHtmlParser(content) and return a non-empty array of courses with dayOfWeek/startSection/duration/startWeek/endWeek."
        : "This is an automatic flow helper script. It may need to support auto login, page navigation, term extraction, timetable detection or structured extraction. Return a structured non-empty object/array that matches the target type.";
    const workflowPrompt = [
        `Repair workflow: ${formatScriptRepairWorkflowLabel(workflow)}`,
        `Workflow description: ${describeScriptRepairWorkflow(workflow)}`
    ].join("\n");
    const prompt = [
        "You repair JavaScript parser/provider scripts for an Android course app.",
        "Return strict JSON with keys: diagnosis, patchSummary, proposedScript.",
        "Do not include markdown.",
        workflowPrompt,
        contract,
        `Issue: ${diagnosis}`,
        `Target type: ${issue.target_type}`,
        `Script name: ${issue.affected_script_name}`,
        `Sanitized sample:\n${sample.slice(0, 12000)}`,
        `Old script:\n${oldScript.slice(0, 30000)}`
    ].join("\n\n");
    const response = await callOpenAiCompatible(cfg, prompt);
    if (!response.ok)
        return { script: "", summary: response.error || "model failed", error: response.error || "model_failed" };
    const parsed = parseCandidate(response.text);
    return parsed.script ? parsed : { script: "", summary: "empty proposed script", error: "candidate_empty" };
}
async function callOpenAiCompatible(cfg, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        const response = await fetch(chatCompletionsUrl(cfg.provider, cfg.baseUrl), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: "You output strict JSON only." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.2,
                ...parseExtraBody(cfg.extraBody)
            }),
            signal: controller.signal
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
            return { ok: false, text: "", error: json?.error?.message || `http_${response.status}` };
        return { ok: true, text: String(json?.choices?.[0]?.message?.content || "") };
    }
    catch (error) {
        return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        clearTimeout(timer);
    }
}
function parseExtraBody(value) {
    if (!value.trim())
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
export function chatCompletionsUrl(provider, baseUrl) {
    const base = (baseUrl || "").replace(/\/$/, "");
    if (!base)
        return "https://api.openai.com/v1/chat/completions";
    if (/\/chat\/completions$/.test(base))
        return base;
    if (provider === "deepseek")
        return `${base}/chat/completions`;
    if (provider === "qwen" || base.includes("dashscope.aliyuncs.com")) {
        return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
    }
    return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
}
function parseCandidate(text) {
    const trimmed = text.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
    try {
        const json = JSON.parse(trimmed);
        return {
            script: String(json.proposedScript || json.script || ""),
            summary: String(json.patchSummary || json.diagnosis || "candidate generated")
        };
    }
    catch {
        const fenced = trimmed.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
        return { script: fenced?.[1] || trimmed, summary: "candidate generated from raw model output" };
    }
}
async function loadIssue(issueId) {
    const result = await query("SELECT * FROM repair_issues WHERE issue_id = $1", [issueId]);
    return result.rows[0] || null;
}
async function loadSample(issueId) {
    const result = await query("SELECT sample_id, sanitized_content FROM failure_samples WHERE issue_id = $1 AND has_user_consent = true AND sanitized_content <> '' ORDER BY created_at DESC LIMIT 1", [issueId]);
    return result.rows[0] || null;
}
async function saveRunnerReport(input) {
    const reportId = id("rr");
    await query(`INSERT INTO runner_reports(report_id, issue_id, job_id, script_id, release_id, sample_id, target_type, success, schema_valid,
      result_count, duration_ms, error_code, error_message, report_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [
        reportId,
        input.issueId,
        input.jobId || null,
        input.scriptId,
        input.releaseId || null,
        input.sampleId || null,
        input.targetType,
        input.report.ok === true,
        input.report.schemaValid === true,
        Number(input.report.resultCount || 0),
        Number(input.report.durationMs || 0),
        input.report.errorCode || null,
        input.report.errorMessage || null,
        JSON.stringify(input.report)
    ]);
    return reportId;
}
async function failJob(jobId, issueId, reason) {
    await addIssueEvent({ issueId, jobId, stage: "RUNNER_TESTED", level: "error", message: `自动修复失败：${reason}` });
    await setIssueStage(issueId, "RUNNER_TESTED", "repair failed", reason);
    await query("UPDATE repair_jobs SET status = 'failed', finished_at = now(), error_summary = $2 WHERE job_id = $1", [jobId, reason]);
}
