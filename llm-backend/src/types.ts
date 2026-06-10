export type RepairDomain =
  | "PARSER_FAILURE"
  | "NAVIGATION_FAILURE"
  | "TERM_EXTRACT_FAILURE"
  | "LOGIN_OR_CAPTCHA"
  | "NON_TIMETABLE_PAGE"
  | "CLOUD_PARSE_FAILURE";

export type TargetType = "parser" | "navigation" | "term_extractor" | "cloud_parse" | "none";

export type ReleaseStage = "pending" | "canary" | "active" | "rolled_back" | "disabled";

export type RepairStage =
  | "REPORTED"
  | "CLASSIFIED"
  | "ISSUE_MERGED"
  | "SAMPLE_READY"
  | "REPLAY_BASELINE"
  | "DIAGNOSED"
  | "PATCH_GENERATED"
  | "RUNNER_TESTED"
  | "REGRESSION_TESTED"
  | "PENDING_REVIEW"
  | "CANARY"
  | "ACTIVE"
  | "ROLLED_BACK"
  | "DISABLED";

export interface ParserAttemptInput {
  parserName?: string;
  category?: string;
  parserVersion?: number;
  releaseId?: string;
  scriptSource?: string;
  scriptSha256?: string;
  durationMs?: number;
  success?: boolean;
  resultCount?: number;
  failureType?: string;
  safeErrorCode?: string;
  schemaValid?: boolean;
  confidence?: number;
}

export interface PageFingerprintInput {
  host?: string;
  pathPattern?: string;
  titleHash?: string;
  bodyTextHash?: string;
  htmlStructureHash?: string;
  tableShape?: string;
  formActionHash?: string;
  hasCaptcha?: boolean;
  hasLoginKeyword?: boolean;
  hasCourseKeyword?: boolean;
}

export interface ParseReportInput {
  session?: Record<string, unknown>;
  pageFingerprint?: PageFingerprintInput;
  attempts?: ParserAttemptInput[];
  finalSuccess?: boolean;
  finalFailureType?: string;
  failureStage?: string;
  repairDomain?: RepairDomain;
  targetType?: TargetType;
  sourceUrl?: string;
  classificationHint?: Record<string, unknown>;
  consentAt?: number | string;
  sanitizedSample?: {
    hasUserConsent?: boolean;
    sanitizerVersion?: number;
    contentSha256?: string;
    content?: string;
  };
}

export interface IssueResolution {
  repairDomain: RepairDomain;
  targetType: TargetType;
  scriptId: string;
  scriptName: string;
  category: string;
  version: number;
  issueKey: string;
  failureType: string;
  sourceHost: string;
  shouldAutoRepair: boolean;
  reason: string;
  confidence: number;
  evidence: string[];
}

export interface RunnerRequest {
  scriptContent: string;
  dependencies?: Array<{ name: string; content: string }>;
  sampleContent: string;
  targetType: TargetType;
  entry?: string;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface RunnerResponse {
  ok: boolean;
  status: "passed" | "failed" | "timeout" | "invalid";
  durationMs: number;
  schemaValid: boolean;
  resultCount: number;
  result?: unknown;
  console?: string[];
  errorCode?: string;
  errorMessage?: string;
}
