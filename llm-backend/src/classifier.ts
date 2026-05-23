import { IssueResolution, PageFingerprintInput, ParserAttemptInput, RepairDomain, TargetType } from "./types.js";
import { hostFromUrl, normalizeSystemType, parserForSystem, scriptId, sha256 } from "./utils.js";

interface ClassifyInput {
  session?: Record<string, unknown>;
  pageFingerprint?: PageFingerprintInput;
  attempts: ParserAttemptInput[];
  finalFailureType?: string;
  failureStage?: string;
  repairDomain?: RepairDomain;
  targetType?: TargetType;
  sourceUrl?: string;
  sanitizedContent?: string;
}

export function classifyFailure(input: ClassifyInput): IssueResolution {
  const session = input.session || {};
  const fingerprint = input.pageFingerprint || {};
  const systemType = normalizeSystemType(String(session.schoolSystemType || ""));
  const sourceUrl = String(input.sourceUrl || session.sourceUrl || "");
  const sourceHost = fingerprint.host || hostFromUrl(sourceUrl);
  const sourceUrlText = `${sourceUrl} ${fingerprint.pathPattern || ""}`.toLowerCase();
  const content = (input.sanitizedContent || "").toLowerCase();
  const attemptSignals = input.attempts
    .map((attempt) => `${attempt.parserName || ""} ${attempt.failureType || ""} ${attempt.safeErrorCode || ""}`)
    .join(" ")
    .toLowerCase();
  const failureText = `${input.finalFailureType || ""} ${input.failureStage || ""} ${sourceUrlText} ${attemptSignals} ${content.slice(0, 500)}`.toLowerCase();
  const lastAttempt = input.attempts.find((attempt) => attempt.parserName) || input.attempts[0] || {};
  const attemptName = lastAttempt.parserName || parserForSystem(systemType);
  const attemptVersion = Number(lastAttempt.parserVersion || 0);
  const zhengfangPortalContext = looksLikeZhengfangPortal(systemType, sourceHost, sourceUrlText, content);

  let repairDomain: RepairDomain = input.repairDomain || "PARSER_FAILURE";
  let targetType: TargetType = input.targetType || "parser";
  let category = "parsers";
  let scriptName = attemptName;
  let shouldAutoRepair = true;
  let reason = "parser failure";

  if (fingerprint.hasCaptcha || failureText.includes("captcha") || failureText.includes("验证码")) {
    repairDomain = "LOGIN_OR_CAPTCHA";
    targetType = "none";
    category = "none";
    scriptName = "none";
    shouldAutoRepair = false;
    reason = "login or captcha page";
  } else if (fingerprint.hasLoginKeyword || failureText.includes("login") || failureText.includes("未登录") || failureText.includes("登录")) {
    repairDomain = "LOGIN_OR_CAPTCHA";
    targetType = "none";
    category = "none";
    scriptName = "none";
    shouldAutoRepair = false;
    reason = "user needs login";
  } else if (
    failureText.includes("term") ||
    failureText.includes("semester") ||
    failureText.includes("学期") ||
    failureText.includes("学年") ||
    failureText.includes("extractor_empty")
  ) {
    repairDomain = "TERM_EXTRACT_FAILURE";
    targetType = "term_extractor";
    category = "js";
    scriptName = "auto_sync_extractor.js";
    reason = "term option extraction failed";
  } else if (
    failureText.includes("nav") ||
    failureText.includes("navigation") ||
    failureText.includes("入口") ||
    failureText.includes("菜单") ||
    failureText.includes("跳转")
  ) {
    repairDomain = "NAVIGATION_FAILURE";
    targetType = "navigation";
    category = "js";
    scriptName = "zf_nav.js";
    reason = "navigation failed";
  } else if (failureText.includes("cloud") || failureText.includes("云端")) {
    repairDomain = "CLOUD_PARSE_FAILURE";
    targetType = "cloud_parse";
    category = "parsers";
    scriptName = attemptName;
    reason = "cloud fallback failed";
  } else if (!fingerprint.hasCourseKeyword && !looksLikeTimetable(content) && zhengfangPortalContext) {
    repairDomain = "NAVIGATION_FAILURE";
    targetType = "navigation";
    category = "js";
    scriptName = "zf_nav.js";
    reason = "zhengfang portal detected but timetable page not reached";
  } else if (!fingerprint.hasCourseKeyword && !looksLikeTimetable(content)) {
    repairDomain = "NON_TIMETABLE_PAGE";
    targetType = "none";
    category = "none";
    scriptName = "none";
    shouldAutoRepair = false;
    reason = "non timetable page";
  }

  const failureType = normalizeFailureType(input.finalFailureType, repairDomain);
  const scriptIdentity = scriptName === "none" ? "none.none" : scriptId(category, scriptName);
  const issueKey = sha256(
    [
      normalizeSystemType(systemType),
      sourceHost,
      fingerprint.htmlStructureHash || fingerprint.bodyTextHash || fingerprint.pathPattern || "",
      repairDomain,
      scriptIdentity,
      attemptVersion,
      failureType
    ].join("|")
  );

  return {
    repairDomain,
    targetType,
    scriptId: scriptIdentity,
    scriptName,
    category,
    version: attemptVersion,
    issueKey,
    failureType,
    sourceHost,
    shouldAutoRepair,
    reason
  };
}

function looksLikeTimetable(content: string): boolean {
  if (!content) return false;
  return /课表|课程|星期|节次|上课|教师|教室|timetable|schedule|kbtable|xskb|kbcx|kblist/.test(content);
}

function looksLikeZhengfangPortal(systemType: string, sourceHost: string, sourceUrlText: string, content: string): boolean {
  if (normalizeSystemType(systemType) !== "ZF") return false;
  const combined = `${sourceHost} ${sourceUrlText} ${content.slice(0, 200)}`.toLowerCase();
  return /(jwglxt|jwxt|xtgl|mmgl_|index_initmenu|xskb|xskbcx|kbcx|jsxsd)/.test(combined);
}

function normalizeFailureType(value: string | undefined, domain: RepairDomain): string {
  const raw = String(value || "").toLowerCase();
  if (domain === "TERM_EXTRACT_FAILURE") return "term_extract_failure";
  if (domain === "NAVIGATION_FAILURE") return "navigation_failure";
  if (domain === "LOGIN_OR_CAPTCHA") return "login_or_captcha";
  if (domain === "NON_TIMETABLE_PAGE") return "non_timetable_page";
  if (raw.includes("empty")) return "parser_empty";
  if (raw.includes("schema")) return "schema_invalid";
  if (raw.includes("crash") || raw.includes("exception")) return "parser_crash";
  if (raw.includes("cloud")) return "cloud_parse_failure";
  return "parser_failure";
}
