import { hostFromUrl, normalizeSystemType, parserForSystem, scriptId, sha256 } from "./utils.js";
const STAGE_ALIASES = {
    NAV: "NAVIGATION",
    NAVIGATION_FAILURE: "NAVIGATION",
    TERM: "TERM_EXTRACT",
    TERM_EXTRACT_FAILURE: "TERM_EXTRACT",
    TERM_EXTRACTOR: "TERM_EXTRACT",
    PARSER_FAILURE: "PARSER",
    PARSER_EMPTY: "PARSER",
    PARSER_CRASH: "PARSER",
    CLOUD: "CLOUD_PARSE",
    CLOUD_PARSE_FAILURE: "CLOUD_PARSE",
    LOGIN: "LOGIN_OR_CAPTCHA",
    CAPTCHA: "LOGIN_OR_CAPTCHA",
    UNSUPPORTED_PAGE: "NON_TIMETABLE_PAGE"
};
export function classifyFailure(input) {
    const session = input.session || {};
    const fingerprint = input.pageFingerprint || {};
    const systemType = normalizeSystemType(String(session.schoolSystemType || ""));
    const sourceUrl = String(input.sourceUrl || session.sourceUrl || "");
    const sourceHost = (fingerprint.host || hostFromUrl(sourceUrl)).toLowerCase();
    const sourceUrlText = `${sourceUrl} ${fingerprint.pathPattern || ""}`.toLowerCase();
    const content = (input.sanitizedContent || "").toLowerCase();
    const attempts = input.attempts || [];
    const attemptSignals = attempts
        .map((attempt) => `${attempt.parserName || ""} ${attempt.failureType || ""} ${attempt.safeErrorCode || ""}`)
        .join(" ")
        .toLowerCase();
    const failureText = `${input.finalFailureType || ""} ${input.failureStage || ""} ${sourceUrlText} ${attemptSignals} ${content.slice(0, 800)}`.toLowerCase();
    const lastAttempt = attempts.find((attempt) => attempt.parserName) || attempts[0] || {};
    const attemptName = lastAttempt.parserName || parserForSystem(systemType);
    const attemptVersion = Number(lastAttempt.parserVersion || 0);
    const explicitStage = normalizeFailureStage(input.failureStage);
    const resolution = buildDefaultResolution(input, attemptName);
    if (explicitStage) {
        resolution.evidence.push(`failureStage=${explicitStage}`);
        applyExplicitStage(resolution, explicitStage, attemptName);
    }
    else {
        applyHeuristics(resolution, {
            systemType,
            sourceHost,
            sourceUrlText,
            content,
            failureText,
            fingerprint,
            attemptName
        });
    }
    if (input.repairDomain && input.repairDomain !== "CLOUD_PARSE_FAILURE") {
        resolution.evidence.push(`client repairDomain=${input.repairDomain}`);
    }
    if (input.targetType && input.targetType !== "cloud_parse") {
        resolution.evidence.push(`client targetType=${input.targetType}`);
    }
    const failureType = normalizeFailureType(input.finalFailureType, resolution.repairDomain);
    const scriptIdentity = resolution.scriptName === "none" ? "none.none" : scriptId(resolution.category, resolution.scriptName);
    const issueKey = sha256([
        normalizeSystemType(systemType),
        sourceHost,
        fingerprint.htmlStructureHash || fingerprint.bodyTextHash || fingerprint.pathPattern || "",
        resolution.repairDomain,
        scriptIdentity,
        attemptVersion,
        failureType
    ].join("|"));
    return {
        repairDomain: resolution.repairDomain,
        targetType: resolution.targetType,
        scriptId: scriptIdentity,
        scriptName: resolution.scriptName,
        category: resolution.category,
        version: attemptVersion,
        issueKey,
        failureType,
        sourceHost,
        shouldAutoRepair: resolution.shouldAutoRepair,
        reason: resolution.reason,
        confidence: clampConfidence(resolution.confidence),
        evidence: resolution.evidence.length ? resolution.evidence : ["fallback classifier rule"]
    };
}
function buildDefaultResolution(input, attemptName) {
    const repairDomain = input.repairDomain || "PARSER_FAILURE";
    const targetType = input.targetType || "parser";
    return {
        repairDomain,
        targetType,
        category: targetType === "parser" ? "parsers" : targetType === "none" ? "none" : "js",
        scriptName: attemptName,
        shouldAutoRepair: targetType !== "none" && repairDomain !== "CLOUD_PARSE_FAILURE",
        reason: "parser failure",
        confidence: 0.55,
        evidence: []
    };
}
function applyExplicitStage(resolution, stage, attemptName) {
    if (stage === "LOGIN_OR_CAPTCHA") {
        Object.assign(resolution, noRepair("LOGIN_OR_CAPTCHA", "login or captcha page", 0.95));
        return;
    }
    if (stage === "NON_TIMETABLE_PAGE") {
        Object.assign(resolution, noRepair("NON_TIMETABLE_PAGE", "non timetable page", 0.92));
        return;
    }
    if (stage === "TERM_EXTRACT") {
        Object.assign(resolution, {
            repairDomain: "TERM_EXTRACT_FAILURE",
            targetType: "term_extractor",
            category: "js",
            scriptName: "auto_sync_extractor.js",
            shouldAutoRepair: true,
            reason: "term option extraction failed",
            confidence: 0.9
        });
        return;
    }
    if (stage === "NAVIGATION") {
        Object.assign(resolution, {
            repairDomain: "NAVIGATION_FAILURE",
            targetType: "navigation",
            category: "js",
            scriptName: "zf_nav.js",
            shouldAutoRepair: true,
            reason: "navigation failed",
            confidence: 0.9
        });
        return;
    }
    if (stage === "CLOUD_PARSE") {
        Object.assign(resolution, {
            repairDomain: "CLOUD_PARSE_FAILURE",
            targetType: "cloud_parse",
            category: "parsers",
            scriptName: attemptName,
            shouldAutoRepair: false,
            reason: "cloud fallback failed; awaiting concrete repair target",
            confidence: 0.82
        });
        return;
    }
    Object.assign(resolution, {
        repairDomain: "PARSER_FAILURE",
        targetType: "parser",
        category: "parsers",
        scriptName: attemptName,
        shouldAutoRepair: true,
        reason: "parser failure",
        confidence: 0.85
    });
}
function applyHeuristics(resolution, input) {
    const { systemType, sourceHost, sourceUrlText, content, failureText, fingerprint, attemptName } = input;
    if (fingerprint.hasCaptcha || includesAny(failureText, ["captcha", "验证码", "verify code"])) {
        resolution.evidence.push("captcha marker detected");
        Object.assign(resolution, noRepair("LOGIN_OR_CAPTCHA", "login or captcha page", 0.9));
        return;
    }
    if (fingerprint.hasLoginKeyword || includesAny(failureText, ["login", "未登录", "登录", "账号", "password"])) {
        resolution.evidence.push("login marker detected");
        Object.assign(resolution, noRepair("LOGIN_OR_CAPTCHA", "user needs login", 0.88));
        return;
    }
    if (includesAny(failureText, ["term", "semester", "学期", "学年", "extractor_empty", "term_options_empty"])) {
        resolution.evidence.push("term extraction marker detected");
        Object.assign(resolution, {
            repairDomain: "TERM_EXTRACT_FAILURE",
            targetType: "term_extractor",
            category: "js",
            scriptName: "auto_sync_extractor.js",
            shouldAutoRepair: true,
            reason: "term option extraction failed",
            confidence: 0.78
        });
        return;
    }
    if (includesAny(failureText, ["nav", "navigation", "入口", "菜单", "跳转"])) {
        resolution.evidence.push("navigation marker detected");
        Object.assign(resolution, {
            repairDomain: "NAVIGATION_FAILURE",
            targetType: "navigation",
            category: "js",
            scriptName: "zf_nav.js",
            shouldAutoRepair: true,
            reason: "navigation failed",
            confidence: 0.78
        });
        return;
    }
    if (includesAny(failureText, ["cloud", "云端"])) {
        resolution.evidence.push("cloud fallback marker detected");
        Object.assign(resolution, {
            repairDomain: "CLOUD_PARSE_FAILURE",
            targetType: "cloud_parse",
            category: "parsers",
            scriptName: attemptName,
            shouldAutoRepair: false,
            reason: "cloud fallback failed; awaiting concrete repair target",
            confidence: 0.72
        });
        return;
    }
    if (!fingerprint.hasCourseKeyword && !looksLikeTimetable(content) && looksLikeZhengfangPortal(systemType, sourceHost, sourceUrlText, content)) {
        resolution.evidence.push("zhengfang portal detected without timetable markers");
        Object.assign(resolution, {
            repairDomain: "NAVIGATION_FAILURE",
            targetType: "navigation",
            category: "js",
            scriptName: "zf_nav.js",
            shouldAutoRepair: true,
            reason: "zhengfang portal detected but timetable page not reached",
            confidence: 0.74
        });
        return;
    }
    if (!fingerprint.hasCourseKeyword && !looksLikeTimetable(content)) {
        resolution.evidence.push("no timetable markers detected");
        Object.assign(resolution, noRepair("NON_TIMETABLE_PAGE", "non timetable page", 0.7));
    }
}
function noRepair(domain, reason, confidence) {
    return {
        repairDomain: domain,
        targetType: "none",
        category: "none",
        scriptName: "none",
        shouldAutoRepair: false,
        reason,
        confidence
    };
}
function normalizeFailureStage(value) {
    const raw = String(value || "").trim().toUpperCase();
    return STAGE_ALIASES[raw] || raw;
}
function looksLikeTimetable(content) {
    if (!content)
        return false;
    return /课表|课程|星期|节次|上课|教师|教室|timetable|schedule|kbtable|xskb|kbcx|kblist/.test(content);
}
function looksLikeZhengfangPortal(systemType, sourceHost, sourceUrlText, content) {
    if (normalizeSystemType(systemType) !== "ZF")
        return false;
    const combined = `${sourceHost} ${sourceUrlText} ${content.slice(0, 300)}`.toLowerCase();
    return /(jwglxt|jwxt|xtgl|mmgl_|index_initmenu|xskb|xskbcx|kbcx|jsxsd)/.test(combined);
}
function normalizeFailureType(value, domain) {
    const raw = String(value || "").toLowerCase();
    if (domain === "TERM_EXTRACT_FAILURE")
        return "term_extract_failure";
    if (domain === "NAVIGATION_FAILURE")
        return "navigation_failure";
    if (domain === "LOGIN_OR_CAPTCHA")
        return "login_or_captcha";
    if (domain === "NON_TIMETABLE_PAGE")
        return "non_timetable_page";
    if (domain === "CLOUD_PARSE_FAILURE")
        return "cloud_parse_failure";
    if (raw.includes("empty"))
        return "parser_empty";
    if (raw.includes("schema"))
        return "schema_invalid";
    if (raw.includes("crash") || raw.includes("exception"))
        return "parser_crash";
    return "parser_failure";
}
function includesAny(value, needles) {
    return needles.some((needle) => value.includes(needle.toLowerCase()));
}
function clampConfidence(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}
