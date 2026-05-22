import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, "..");

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://dawn:dawn@postgres:5432/dawn_course",
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",
  runnerUrl: process.env.RUNNER_URL || "http://script-runner:8090",
  scriptOutputDir: process.env.SCRIPT_OUTPUT_DIR || "/shared/parsers",
  legacyScriptDirs: (process.env.LEGACY_SCRIPT_OUTPUT_DIRS || "/shared/scripts/parsers,/shared/scripts/js")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  backendMirrorLogFile: process.env.BACKEND_MIRROR_LOG_FILE || "/shared/parsers/llm-backend.log",
  metricsFile: process.env.SCHOOL_METRICS_FILE || "/shared/parsers/metrics/school_metrics.txt",
  maxContentLength: Number(process.env.MAX_CONTENT_LENGTH || 200000),
  minQueueSize: Number(process.env.MIN_QUEUE_SIZE || 3),
  repairTimeoutMs: Number(process.env.REPAIR_TIMEOUT_MS || 120000),
  runnerTimeoutMs: Number(process.env.RUNNER_TIMEOUT_MS || 5000),
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  adminSessionTtlMs: Number(process.env.ADMIN_SESSION_TTL_MS || 43200000),
  signPrivateKey: process.env.SCRIPT_SIGN_PRIVATE_KEY || process.env.SCRIPT_SIGN_KEY || "",
  verifyPublicKey: process.env.SCRIPT_VERIFY_PUBLIC_KEY || "",
  llmSummary: {
    provider: process.env.LLM_SUMMARY_PROVIDER || "gpt",
    model: process.env.LLM_SUMMARY_MODEL || "gpt-4o-mini",
    apiKey: process.env.LLM_SUMMARY_API_KEY || "",
    baseUrl: process.env.LLM_SUMMARY_BASE_URL || "",
    timeoutMs: Number(process.env.LLM_SUMMARY_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 30000)
  },
  llmScript: {
    provider: process.env.LLM_SCRIPT_PROVIDER || "gpt",
    model: process.env.LLM_SCRIPT_MODEL || "gpt-4o",
    apiKey: process.env.LLM_SCRIPT_API_KEY || "",
    baseUrl: process.env.LLM_SCRIPT_BASE_URL || "",
    timeoutMs: Number(process.env.LLM_SCRIPT_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 60000)
  },
  migrationsDir: process.env.MIGRATIONS_DIR || path.join(rootDir, "migrations")
};
