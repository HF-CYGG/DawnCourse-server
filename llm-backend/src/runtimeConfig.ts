import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { query } from "./db.js";
import { log } from "./log.js";

export interface ModelRuntimeConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  apiStyle: string;
  extraBody: string;
  timeoutMs: number;
}

export interface PlatformRuntimeConfig {
  publicBaseUrl: string;
  runnerUrl: string;
  minQueueSize: number;
  runnerTimeoutMs: number;
}

interface SigningKeyPair {
  privateKey: string;
  publicKey: string;
  generated: boolean;
  privateKeyPath: string;
  publicKeyPath: string;
}

let cachedSigningKeyPair: SigningKeyPair | null = null;

export function ensureSigningKeyPair(): SigningKeyPair {
  if (cachedSigningKeyPair) return cachedSigningKeyPair;
  const keyDir = path.join(config.scriptOutputDir, "keys");
  const privateKeyPath = path.join(keyDir, "script_sign_private.pem");
  const publicKeyPath = path.join(keyDir, "script_sign_public.pem");
  fs.mkdirSync(keyDir, { recursive: true });

  const envPrivateKey = (config.signPrivateKey || "").replace(/\\n/g, "\n").trim();
  const envPublicKey = (config.verifyPublicKey || "").replace(/\\n/g, "\n").trim();
  if (envPrivateKey) {
    const publicKey = envPublicKey || crypto.createPublicKey(envPrivateKey).export({ type: "spki", format: "pem" }).toString();
    cachedSigningKeyPair = { privateKey: envPrivateKey, publicKey, generated: false, privateKeyPath: "env:SCRIPT_SIGN_PRIVATE_KEY", publicKeyPath: "env:SCRIPT_VERIFY_PUBLIC_KEY" };
    return cachedSigningKeyPair;
  }

  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    cachedSigningKeyPair = {
      privateKey: fs.readFileSync(privateKeyPath, "utf8"),
      publicKey: fs.readFileSync(publicKeyPath, "utf8"),
      generated: false,
      privateKeyPath,
      publicKeyPath
    };
    return cachedSigningKeyPair;
  }

  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  fs.writeFileSync(privateKeyPath, pair.privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, pair.publicKey, { mode: 0o644 });
  cachedSigningKeyPair = {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    generated: true,
    privateKeyPath,
    publicKeyPath
  };
  log.info("generated script signing key pair", { publicKeyPath });
  return cachedSigningKeyPair;
}

export function getSigningStatus(): Record<string, unknown> {
  const pair = ensureSigningKeyPair();
  return {
    configured: true,
    generated: pair.generated,
    privateKeyPath: pair.privateKeyPath.startsWith("env:") ? pair.privateKeyPath : pair.privateKeyPath,
    publicKeyPath: pair.publicKeyPath,
    publicKey: pair.publicKey
  };
}

export async function getRuntimeModelConfig(target: "summary" | "script"): Promise<ModelRuntimeConfig> {
  const stored = await query<{ value_json: Record<string, unknown> }>("SELECT value_json FROM system_config WHERE key = 'model_config'");
  const value = stored.rows[0]?.value_json || {};
  const envCfg = target === "summary" ? config.llmSummary : config.llmScript;
  const prefix = target === "summary" ? "summary" : "script";
  return {
    provider: asString(value[`${prefix}ProviderRaw`], envCfg.provider),
    model: asString(value[`${prefix}ModelRaw`], envCfg.model),
    apiKey: asString(value[`${prefix}ApiKey`], envCfg.apiKey),
    baseUrl: asString(value[`${prefix}BaseUrl`], envCfg.baseUrl),
    apiStyle: asString(value[`${prefix}ApiStyleRaw`], "auto"),
    extraBody: asString(value[`${prefix}RequestExtraJson`], ""),
    timeoutMs: asNumber(value[`${prefix}TimeoutMs`], envCfg.timeoutMs)
  };
}

export async function getAdminConfigPayload(): Promise<Record<string, unknown>> {
  const stored = await query<{ value_json: Record<string, unknown> }>("SELECT value_json FROM system_config WHERE key = 'model_config'");
  const value = stored.rows[0]?.value_json || {};
  const summary = await getRuntimeModelConfig("summary");
  const script = await getRuntimeModelConfig("script");
  return {
    summaryProviderRaw: value.summaryProviderRaw || summary.provider,
    summaryModelRaw: value.summaryModelRaw || summary.model,
    summaryApiKey: value.summaryApiKey || summary.apiKey,
    summaryBaseUrl: value.summaryBaseUrl || summary.baseUrl,
    summaryApiStyleRaw: value.summaryApiStyleRaw || summary.apiStyle,
    summaryRequestExtraJson: value.summaryRequestExtraJson || summary.extraBody,
    summaryTimeoutMs: value.summaryTimeoutMs || summary.timeoutMs,
    patchGuidanceTimeoutMs: value.patchGuidanceTimeoutMs || summary.timeoutMs,
    scriptProviderRaw: value.scriptProviderRaw || script.provider,
    scriptModelRaw: value.scriptModelRaw || script.model,
    scriptApiKey: value.scriptApiKey || script.apiKey,
    scriptBaseUrl: value.scriptBaseUrl || script.baseUrl,
    scriptApiStyleRaw: value.scriptApiStyleRaw || script.apiStyle,
    scriptRequestExtraJson: value.scriptRequestExtraJson || script.extraBody,
    scriptTimeoutMs: value.scriptTimeoutMs || script.timeoutMs,
    modelAliasJson: value.modelAliasJson || "",
    usageEnabled: Boolean(value.usageEnabled),
    summaryUsageUrl: value.summaryUsageUrl || "",
    summaryCostUrl: value.summaryCostUrl || "",
    scriptUsageUrl: value.scriptUsageUrl || "",
    scriptCostUrl: value.scriptCostUrl || "",
    publicBaseUrl: value.publicBaseUrl || config.publicBaseUrl || "",
    runnerUrl: value.runnerUrl || config.runnerUrl,
    minQueueSize: value.minQueueSize || config.minQueueSize,
    runnerTimeoutMs: value.runnerTimeoutMs || config.runnerTimeoutMs,
    signing: getSigningStatus(),
    runtime: {
      databaseConfigured: Boolean(config.databaseUrl),
      redisConfigured: Boolean(config.redisUrl),
      runnerUrl: value.runnerUrl || config.runnerUrl,
      scriptOutputDir: config.scriptOutputDir,
      publicBaseUrl: value.publicBaseUrl || config.publicBaseUrl || "auto"
    }
  };
}

export async function getRuntimePlatformConfig(): Promise<PlatformRuntimeConfig> {
  const stored = await query<{ value_json: Record<string, unknown> }>("SELECT value_json FROM system_config WHERE key = 'model_config'");
  const value = stored.rows[0]?.value_json || {};
  return {
    publicBaseUrl: asString(value.publicBaseUrl, config.publicBaseUrl),
    runnerUrl: asString(value.runnerUrl, config.runnerUrl),
    minQueueSize: asNumber(value.minQueueSize, config.minQueueSize),
    runnerTimeoutMs: asNumber(value.runnerTimeoutMs, config.runnerTimeoutMs)
  };
}

export async function getManifestPublicBaseUrl(host?: string): Promise<string> {
  const runtime = await getRuntimePlatformConfig();
  return (runtime.publicBaseUrl || (host ? `http://${host}` : "")).replace(/\/$/, "");
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
