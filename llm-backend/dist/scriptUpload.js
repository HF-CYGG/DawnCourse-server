import { query, withTx } from "./db.js";
import { getActiveScriptContent } from "./registry.js";
import { runScript } from "./runnerClient.js";
import { buildScriptKey } from "./scriptRelease.js";
import { id, normalizeSystemType, safeSegment, scriptId, sha256, signContent } from "./utils.js";
const MAX_UPLOAD_BYTES = 256 * 1024;
const ALLOWED_CATEGORIES = new Set(["parsers", "js"]);
const ALLOWED_WEB_TARGETS = new Set(["navigation", "term_extractor"]);
export function validateScriptUploadInput(input) {
    const category = String(input.category || "").trim();
    const name = String(input.name || "").trim();
    const targetType = String(input.targetType || "").trim();
    const scopeKind = String(input.scopeKind || "").trim();
    const scopeId = String(input.scopeId || "").trim();
    const content = String(input.content || "");
    if (category === "runtime")
        return { ok: false, error: "runtime_upload_forbidden" };
    if (!ALLOWED_CATEGORIES.has(category))
        return { ok: false, error: "invalid_category" };
    if (!safeSegment(name) || !name.toLowerCase().endsWith(".js"))
        return { ok: false, error: "invalid_script_name" };
    if (!content.trim())
        return { ok: false, error: "script_content_required" };
    if (Buffer.byteLength(content, "utf8") > MAX_UPLOAD_BYTES)
        return { ok: false, error: "script_too_large" };
    if (content.includes("\u0000") || content.includes("\uFFFD"))
        return { ok: false, error: "invalid_utf8_script" };
    if (scopeKind !== "school" && scopeKind !== "system")
        return { ok: false, error: "invalid_scope_kind" };
    if (scopeKind === "school" && !scopeId)
        return { ok: false, error: "school_scope_id_required" };
    if (scopeKind === "system" && normalizeSystemType(scopeId) === "UNKNOWN") {
        return { ok: false, error: "system_scope_id_required" };
    }
    if (category === "parsers" && targetType !== "parser")
        return { ok: false, error: "invalid_parser_target" };
    if (category === "js" && !ALLOWED_WEB_TARGETS.has(targetType))
        return { ok: false, error: "invalid_web_target" };
    if (category === "js") {
        if (!String(input.testSchoolId || "").trim() ||
            !String(input.pageStage || "").trim() ||
            !String(input.manualValidationResult || "").trim() ||
            input.manualValidationPassed !== true) {
            return { ok: false, error: "manual_validation_required" };
        }
    }
    return { ok: true, error: "" };
}
export async function createUploadedScriptRelease(rawInput, actor, deps = {}) {
    const validation = validateScriptUploadInput(rawInput);
    if (!validation.ok)
        throw new Error(validation.error);
    const queryFn = (deps.query || query);
    const withTxFn = (deps.withTx || withTx);
    const runScriptFn = deps.runScript || runScript;
    const getActiveFn = deps.getActiveScriptContent || getActiveScriptContent;
    const input = normalizeInput(rawInput);
    const scriptKey = buildScriptKey(input);
    const parentResult = input.parentReleaseId
        ? await queryFn("SELECT release_id FROM script_releases WHERE release_id = $1 AND script_key = $2 LIMIT 1", [input.parentReleaseId, scriptKey])
        : await queryFn(`SELECT release_id FROM script_releases
         WHERE script_key = $1 AND release_stage = 'active' AND status = 'enabled' AND kill_switch = false
         ORDER BY version DESC LIMIT 1`, [scriptKey]);
    if (input.parentReleaseId && !parentResult.rows[0])
        throw new Error("parent_release_scope_mismatch");
    const parentReleaseId = String(parentResult.rows[0]?.release_id || "");
    const versionResult = await queryFn("SELECT COALESCE(MAX(version),0) AS version FROM script_artifacts WHERE script_key = $1", [scriptKey]);
    const version = Number(versionResult.rows[0]?.version || 0) + 1;
    const validationReport = input.category === "parsers"
        ? await validateParserCandidate(input, queryFn, runScriptFn, getActiveFn)
        : {
            kind: "manual_webview",
            testSchoolId: input.testSchoolId,
            pageStage: input.pageStage,
            result: input.manualValidationResult,
            passed: true
        };
    const releaseId = id("rel");
    const contentHash = sha256(input.content);
    const signature = signContent(input.content);
    const dependency = input.category === "parsers" && input.name !== "common_parser_utils.js"
        ? await getActiveFn("parsers", "common_parser_utils.js")
        : null;
    await withTxFn(async (client) => {
        await client.query(`INSERT INTO script_artifacts(
         script_id,script_key,target_type,category,name,version,release_id,content,content_sha256,signature,
         parent_release_id,provenance,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`, [
            scriptId(input.category, input.name), scriptKey, input.targetType, input.category, input.name, version,
            releaseId, input.content, contentHash, signature, parentReleaseId || null,
            JSON.stringify({ source: "admin_upload", validation: validationReport }), actor
        ]);
        await client.query(`INSERT INTO script_releases(
         release_id,script_id,script_key,target_type,category,name,version,release_stage,channel,status,
         rollout_percent,school_system_types_json,school_ids_json,scope_kind,scope_id,school_system_type,
         validation_status,validation_report_json,changelog,parent_release_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','pending','enabled',0,$8::jsonb,$9::jsonb,$10,$11,$12,
         'passed',$13::jsonb,$14,$15)`, [
            releaseId, scriptId(input.category, input.name), scriptKey, input.targetType, input.category, input.name,
            version,
            JSON.stringify(input.schoolSystemType === "UNKNOWN" ? [] : [input.schoolSystemType]),
            JSON.stringify(input.scopeKind === "school" ? [input.scopeId] : []),
            input.scopeKind, input.scopeId, input.schoolSystemType, JSON.stringify(validationReport),
            input.changelog, parentReleaseId || null
        ]);
        if (dependency?.releaseId) {
            await client.query("INSERT INTO script_release_dependencies(release_id,dependency_release_id,load_order) VALUES ($1,$2,0) ON CONFLICT DO NOTHING", [releaseId, dependency.releaseId]);
        }
        if (input.category === "js") {
            await client.query(`INSERT INTO script_manual_validations(validation_id,release_id,school_id,page_stage,result_note,passed,actor)
         VALUES ($1,$2,$3,$4,$5,true,$6)`, [id("val"), releaseId, input.testSchoolId, input.pageStage, input.manualValidationResult, actor]);
        }
        await client.query("INSERT INTO audit_logs(actor,action,target_type,target_id,detail_json) VALUES ($1,'upload_release','script_release',$2,$3::jsonb)", [actor, releaseId, JSON.stringify({ scriptKey, version, validationReport })]);
    });
    return { releaseId, scriptKey, version, validationStatus: "passed", validationReport };
}
export async function revalidateScriptRelease(releaseId, manualInput, actor, deps = {}) {
    const queryFn = (deps.query || query);
    const runScriptFn = deps.runScript || runScript;
    const getActiveFn = deps.getActiveScriptContent || getActiveScriptContent;
    const releaseResult = await queryFn(`SELECT r.*,a.content FROM script_releases r
     JOIN script_artifacts a ON a.release_id = r.release_id
     WHERE r.release_id = $1 LIMIT 1`, [releaseId]);
    const release = releaseResult.rows[0];
    if (!release)
        throw new Error("release_not_found");
    const input = normalizeInput({
        name: String(release.name || ""),
        category: String(release.category || ""),
        targetType: String(release.target_type || ""),
        scopeKind: String(release.scope_kind || ""),
        scopeId: String(release.scope_id || ""),
        schoolSystemType: String(release.school_system_type || "UNKNOWN"),
        content: String(release.content || ""),
        changelog: String(release.changelog || ""),
        testSchoolId: manualInput.testSchoolId,
        pageStage: manualInput.pageStage,
        manualValidationResult: manualInput.manualValidationResult,
        manualValidationPassed: manualInput.manualValidationPassed
    });
    const validation = validateScriptUploadInput(input);
    if (!validation.ok)
        throw new Error(validation.error);
    try {
        const validationReport = input.category === "parsers"
            ? await validateParserCandidate(input, queryFn, runScriptFn, getActiveFn)
            : {
                kind: "manual_webview",
                testSchoolId: input.testSchoolId,
                pageStage: input.pageStage,
                result: input.manualValidationResult,
                passed: true
            };
        await queryFn("UPDATE script_releases SET validation_status = 'passed',validation_report_json = $2::jsonb WHERE release_id = $1", [releaseId, JSON.stringify(validationReport)]);
        if (input.category === "js") {
            await queryFn(`INSERT INTO script_manual_validations(validation_id,release_id,school_id,page_stage,result_note,passed,actor)
         VALUES ($1,$2,$3,$4,$5,true,$6)`, [id("val"), releaseId, input.testSchoolId, input.pageStage, input.manualValidationResult, actor]);
        }
        await queryFn("INSERT INTO audit_logs(actor,action,target_type,target_id,detail_json) VALUES ($1,'revalidate_release','script_release',$2,$3::jsonb)", [actor, releaseId, JSON.stringify({ passed: true, validationReport })]);
        return {
            releaseId,
            scriptKey: String(release.script_key || ""),
            version: Number(release.version || 0),
            validationStatus: "passed",
            validationReport
        };
    }
    catch (error) {
        const errorCode = error instanceof Error ? error.message : String(error);
        const report = { passed: false, errorCode, revalidatedAt: new Date().toISOString() };
        await queryFn("UPDATE script_releases SET validation_status = 'failed',validation_report_json = $2::jsonb WHERE release_id = $1", [releaseId, JSON.stringify(report)]);
        await queryFn("INSERT INTO audit_logs(actor,action,target_type,target_id,detail_json) VALUES ($1,'revalidate_release','script_release',$2,$3::jsonb)", [actor, releaseId, JSON.stringify(report)]);
        throw error;
    }
}
function normalizeInput(input) {
    const scopeKind = input.scopeKind;
    const normalizedSystem = normalizeSystemType(scopeKind === "system" ? input.scopeId : input.schoolSystemType);
    return {
        ...input,
        name: input.name.trim(),
        category: input.category.trim(),
        targetType: input.targetType.trim(),
        scopeKind,
        scopeId: scopeKind === "system" ? normalizedSystem : input.scopeId.trim(),
        schoolSystemType: normalizedSystem,
        changelog: input.changelog.trim().slice(0, 2000),
        testSchoolId: String(input.testSchoolId || "").trim(),
        pageStage: String(input.pageStage || "").trim(),
        manualValidationResult: String(input.manualValidationResult || "").trim()
    };
}
async function validateParserCandidate(input, queryFn, runScriptFn, getActiveFn) {
    const sampleSchoolId = input.scopeKind === "school" ? input.scopeId : "";
    const samples = await queryFn(`SELECT sample_id,sanitized_content,school_id,school_system_type
     FROM failure_samples
     WHERE has_user_consent = true AND sanitized_content <> ''
       AND ($1 = '' OR school_id = $1)
       AND ($2 = 'UNKNOWN' OR school_system_type = $2)
     ORDER BY created_at DESC LIMIT 20`, [sampleSchoolId, input.schoolSystemType]);
    if (!samples.rows.length)
        throw new Error("validation_sample_required");
    const harness = await getActiveFn("runtime", "script_host.js");
    if (!harness?.content)
        throw new Error("harness_missing");
    const common = input.name === "common_parser_utils.js"
        ? null
        : await getActiveFn("parsers", "common_parser_utils.js");
    const reports = [];
    for (const sample of samples.rows) {
        const report = await runScriptFn({
            scriptContent: input.content,
            dependencies: common?.content ? [{ name: "common_parser_utils.js", content: common.content }] : [],
            harnessSource: harness.content,
            sampleContent: String(sample.sanitized_content || ""),
            targetType: "parser",
            timeoutMs: 5_000
        });
        reports.push({
            sampleId: String(sample.sample_id || ""),
            schoolId: String(sample.school_id || ""),
            ok: report.ok,
            schemaValid: report.schemaValid,
            resultCount: report.resultCount,
            errorCode: report.errorCode || ""
        });
        if (!report.ok || !report.schemaValid || Number(report.resultCount || 0) <= 0) {
            throw new Error(`runner_validation_failed:${report.errorCode || report.status || "invalid"}`);
        }
    }
    return { kind: "runner_regression", passed: true, sampleCount: reports.length, reports };
}
