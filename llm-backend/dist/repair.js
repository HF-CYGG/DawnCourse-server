import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { createPendingRelease, getActiveScriptContent } from "./registry.js";
import { describeScriptRepairWorkflow, formatScriptRepairWorkflowLabel, resolveScriptRepairWorkflow } from "./repairWorkflow.js";
import { runScript } from "./runnerClient.js";
import { getRuntimeModelConfig, getRuntimePlatformConfig } from "./runtimeConfig.js";
import { id, limitString, scriptId } from "./utils.js";
export function getAutoRepairBlockedReason(issue) {
    if (!issue)
        return "issue not found";
    if (issue.target_type === "none")
        return "failure type is not script-repairable";
    if (issue.repair_domain === "LOGIN_OR_CAPTCHA" || issue.repair_domain === "NON_TIMETABLE_PAGE") {
        return "failure type is not script-repairable";
    }
    return "";
}
export function summarizeBaselineReportsForTest(reports) {
    return { reproduced: reports.length > 0 && reports.every((report) => !isRunnerPass(report)) };
}
export function summarizeCandidateReportsForTest(reports) {
    return { passed: reports.length > 0 && reports.every(isRunnerPass) };
}
export function summarizeRegressionReportsForTest(reports) {
    if (!reports.length)
        return { status: "limited_regression", passed: true };
    return reports.every(isRunnerPass) ? { status: "passed", passed: true } : { status: "failed", passed: false };
}
export async function startRepairJob(issueId, options = {}) {
    const actor = options.actor || "system";
    const issue = await loadIssue(issueId);
    const blockedReason = getAutoRepairBlockedReason(issue);
    if (blockedReason) {
        await addIssueEvent({ issueId, stage: "ISSUE_MERGED", level: "warning", actor, message: blockedReason });
        await setIssueStage(issueId, "ISSUE_MERGED", "repair blocked", blockedReason);
        return { jobId: "", started: false, reason: blockedReason };
    }
    const lock = await query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`repair:${issueId}`]);
    if (!lock.rows[0]?.locked) {
        await addIssueEvent({ issueId, stage: "SAMPLE_READY", level: "warning", actor, message: "repair job already running" });
        return { jobId: "", started: false, reason: "repair_job_already_running" };
    }
    const jobId = id("job");
    await query(`INSERT INTO repair_jobs(job_id, issue_id, status, bypass_min_queue, actor, started_at)
     VALUES ($1,$2,'running',$3,$4,now())`, [jobId, issueId, options.bypassMinQueue === true, actor]);
    void runRepairJob(issueId, jobId, options).finally(async () => {
        await query("SELECT pg_advisory_unlock(hashtext($1))", [`repair:${issueId}`]).catch(() => undefined);
    });
    return { jobId, started: true };
}
export async function runReplayOnly(issueId, actor = "admin") {
    const issue = await loadIssue(issueId);
    const samples = await loadSamples(issueId, 1);
    const sample = samples[0];
    if (!issue || !sample)
        return { ok: false, reason: "missing_issue_or_sample" };
    const active = await getActiveScriptContent(issue.affected_category, issue.affected_script_name);
    if (!active)
        return { ok: false, reason: "missing_active_script" };
    await addIssueEvent({ issueId, stage: "REPLAY_BASELINE", actor, message: "baseline replay started", meta: { script: issue.affected_script_name } });
    const report = await runScript({
        scriptContent: active.content,
        sampleContent: sample.sanitized_content,
        targetType: issue.target_type,
        timeoutMs: config.runnerTimeoutMs
    });
    const reportId = await saveRunnerReport({
        issueId,
        scriptId: issue.affected_script_id,
        releaseId: active.releaseId,
        sampleId: sample.sample_id,
        targetType: issue.target_type,
        report
    });
    const ok = !isRunnerPass(report);
    await addIssueEvent({
        issueId,
        stage: "REPLAY_BASELINE",
        level: ok ? "info" : "warning",
        actor,
        message: ok ? "baseline failure reproduced" : "baseline did not reproduce failure",
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
            await addIssueEvent({
                issueId,
                jobId,
                stage: "SAMPLE_READY",
                level: "info",
                actor,
                message: `waiting for ${runtime.minQueueSize} authorized samples`
            });
            await query("UPDATE repair_jobs SET status = 'waiting', finished_at = now() WHERE job_id = $1", [jobId]);
            return;
        }
        const sampleLimit = options.bypassMinQueue ? 1 : Math.max(3, runtime.minQueueSize);
        const samples = await loadSamples(issueId, sampleLimit);
        if (!samples.length) {
            await failJob(jobId, issueId, "missing_authorized_sample");
            return;
        }
        const active = await getActiveScriptContent(issue.affected_category, issue.affected_script_name);
        if (!active) {
            await failJob(jobId, issueId, "missing_active_script");
            return;
        }
        await setIssueStage(issueId, "REPLAY_BASELINE", "baseline replay running");
        await addIssueEvent({
            issueId,
            jobId,
            stage: "REPLAY_BASELINE",
            actor,
            message: "baseline replay started",
            meta: { targetType: issue.target_type, sampleCount: samples.length }
        });
        const baselineRuns = await runScriptForSamples({
            issue,
            issueId,
            jobId,
            scriptContent: active.content,
            releaseId: active.releaseId,
            samples,
            timeoutMs: config.runnerTimeoutMs
        });
        const baselineSummary = summarizeBaselineReportsForTest(baselineRuns.map((item) => item.report));
        await addIssueEvent({
            issueId,
            jobId,
            stage: "REPLAY_BASELINE",
            level: baselineSummary.reproduced ? "info" : "warning",
            actor,
            message: baselineSummary.reproduced ? "baseline failure reproduced on selected samples" : "baseline did not reproduce failure on every selected sample",
            meta: { reportIds: baselineRuns.map((item) => item.reportId), reports: baselineRuns.map((item) => item.report) }
        });
        if (!baselineSummary.reproduced) {
            await failJob(jobId, issueId, "baseline_not_reproduced");
            return;
        }
        await setIssueStage(issueId, "DIAGNOSED", "diagnosing");
        const firstBaseline = baselineRuns[0]?.report;
        const diagnosis = await diagnose(issue, samples[0].sanitized_content, firstBaseline?.errorMessage || firstBaseline?.errorCode || "empty result");
        await addIssueEvent({ issueId, jobId, stage: "DIAGNOSED", actor, message: "repair diagnosis generated", meta: { diagnosis: diagnosis.summary } });
        await setIssueStage(issueId, "PATCH_GENERATED", "generating candidate");
        const candidate = await generateCandidate(issue, active.content, samples[0].sanitized_content, diagnosis.summary);
        if (!candidate.script.trim()) {
            await failJob(jobId, issueId, candidate.error || "candidate_empty");
            return;
        }
        await addIssueEvent({ issueId, jobId, stage: "PATCH_GENERATED", actor, message: "candidate script generated", meta: { summary: candidate.summary } });
        await setIssueStage(issueId, "RUNNER_TESTED", "candidate test running");
        const candidateRuns = await runScriptForSamples({
            issue,
            issueId,
            jobId,
            scriptContent: candidate.script,
            samples,
            timeoutMs: Math.max(config.runnerTimeoutMs, 10000)
        });
        const candidateSummary = summarizeCandidateReportsForTest(candidateRuns.map((item) => item.report));
        if (!candidateSummary.passed) {
            const failed = candidateRuns.find((item) => !isRunnerPass(item.report))?.report;
            await addIssueEvent({
                issueId,
                jobId,
                stage: "RUNNER_TESTED",
                level: "error",
                actor,
                message: "candidate failed runner test on issue samples",
                meta: { reportIds: candidateRuns.map((item) => item.reportId), reports: candidateRuns.map((item) => item.report) }
            });
            await failJob(jobId, issueId, failed?.errorMessage || failed?.errorCode || "candidate_invalid");
            return;
        }
        await addIssueEvent({ issueId, jobId, stage: "RUNNER_TESTED", actor, message: "candidate passed issue sample tests", meta: { reportIds: candidateRuns.map((item) => item.reportId) } });
        await setIssueStage(issueId, "REGRESSION_TESTED", "regression tested");
        const regressionSamples = await loadRegressionSamples(issue, issueId, 10);
        const regressionRuns = regressionSamples.length
            ? await runScriptForSamples({
                issue,
                issueId,
                jobId,
                scriptContent: candidate.script,
                samples: regressionSamples,
                timeoutMs: Math.max(config.runnerTimeoutMs, 10000)
            })
            : [];
        const regressionSummary = summarizeRegressionReportsForTest(regressionRuns.map((item) => item.report));
        await addIssueEvent({
            issueId,
            jobId,
            stage: "REGRESSION_TESTED",
            level: regressionSummary.passed ? "info" : "error",
            actor,
            message: regressionSummary.status,
            meta: { reportIds: regressionRuns.map((item) => item.reportId), sampleCount: regressionSamples.length }
        });
        if (!regressionSummary.passed) {
            await failJob(jobId, issueId, "regression_failed");
            return;
        }
        const releaseId = await createPendingRelease({
            issueId,
            scriptId: issue.affected_script_id || scriptId(issue.affected_category, issue.affected_script_name),
            targetType: issue.target_type,
            category: issue.affected_category,
            name: issue.affected_script_name,
            content: candidate.script,
            parentReleaseId: active.releaseId,
            changelog: `Auto repair from ${issueId}: ${candidate.summary || diagnosis.summary}`,
            testReportId: candidateRuns[candidateRuns.length - 1]?.reportId,
            actor,
            schoolId: issue.school_id || "",
            schoolSystemType: issue.school_system_type || ""
        });
        await query("UPDATE repair_jobs SET status = 'completed', finished_at = now(), meta_json = $2::jsonb WHERE job_id = $1", [
            jobId,
            JSON.stringify({
                releaseId,
                baselineReportIds: baselineRuns.map((item) => item.reportId),
                candidateReportIds: candidateRuns.map((item) => item.reportId),
                regressionReportIds: regressionRuns.map((item) => item.reportId),
                regressionStatus: regressionSummary.status
            })
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
async function loadSamples(issueId, limit) {
    const result = await query("SELECT sample_id, sanitized_content FROM failure_samples WHERE issue_id = $1 AND has_user_consent = true AND sanitized_content <> '' ORDER BY created_at DESC LIMIT $2", [issueId, Math.max(1, limit)]);
    return result.rows;
}
async function loadRegressionSamples(issue, issueId, limit) {
    const result = await query(`SELECT fs.sample_id, fs.sanitized_content
     FROM failure_samples fs
     JOIN repair_issues ri ON ri.issue_id = fs.issue_id
     WHERE fs.issue_id <> $1
       AND fs.has_user_consent = true
       AND fs.sanitized_content <> ''
       AND ri.affected_script_id = $2
       AND ($3 = '' OR ri.school_system_type = $3)
       AND ($4 = '' OR ri.school_id = $4)
     ORDER BY fs.created_at DESC
     LIMIT $5`, [issueId, issue.affected_script_id, issue.school_system_type || "", issue.school_id || "", Math.max(1, limit)]);
    return result.rows;
}
/** 共享执行契约的脚本标识 */
const SCRIPT_HOST_CATEGORY = "runtime";
const SCRIPT_HOST_NAME = "script_host.js";
/** 所有解析器共用的工具库，必须与脚本一同注入沙箱 */
const COMMON_PARSER_UTILS = "common_parser_utils.js";
/**
 * 读取当前对外服务的共享执行契约源码。
 *
 * 沙箱使用与客户端同一版本的 harness，才能保证「沙箱跑通 == 设备跑通」。
 */
async function loadHarnessSource() {
    const harness = await getActiveScriptContent(SCRIPT_HOST_CATEGORY, SCRIPT_HOST_NAME);
    return harness?.content || "";
}
/**
 * 解析脚本依赖。
 *
 * 规则与客户端保持一致：parsers 分类的脚本统一前置 common_parser_utils.js。
 * 此前沙箱从不注入依赖，导致 zhengfang/qiangzhi/kingosoft 在缺少工具函数的
 * 残缺环境里执行，baseline 与候选脚本都在错误前提下被判定。
 */
async function loadScriptDependencies(category, name) {
    if (category !== "parsers" || name === COMMON_PARSER_UTILS)
        return [];
    const common = await getActiveScriptContent("parsers", COMMON_PARSER_UTILS);
    return common?.content ? [{ name: COMMON_PARSER_UTILS, content: common.content }] : [];
}
async function runScriptForSamples(input) {
    const runs = [];
    const harnessSource = await loadHarnessSource();
    const dependencies = await loadScriptDependencies(input.issue.affected_category, input.issue.affected_script_name);
    for (const sample of input.samples) {
        const report = await runScript({
            scriptContent: input.scriptContent,
            dependencies,
            harnessSource,
            sampleContent: sample.sanitized_content,
            targetType: input.issue.target_type,
            timeoutMs: input.timeoutMs
        });
        const reportId = await saveRunnerReport({
            issueId: input.issueId,
            jobId: input.jobId,
            scriptId: input.issue.affected_script_id,
            releaseId: input.releaseId,
            sampleId: sample.sample_id,
            targetType: input.issue.target_type,
            report
        });
        runs.push({ sample, report, reportId });
    }
    return runs;
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
function isRunnerPass(report) {
    return report.ok === true && report.schemaValid === true && Number(report.resultCount || 0) > 0;
}
async function failJob(jobId, issueId, reason) {
    await addIssueEvent({ issueId, jobId, stage: "RUNNER_TESTED", level: "error", message: `auto repair failed: ${reason}` });
    await setIssueStage(issueId, "RUNNER_TESTED", "repair failed", reason);
    await query("UPDATE repair_jobs SET status = 'failed', finished_at = now(), error_summary = $2 WHERE job_id = $1", [jobId, reason]);
}
