import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { ensureSigningKeyPair } from "./runtimeConfig.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signContent(content: string): string {
  const key = ensureSigningKeyPair().privateKey;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(content);
  signer.end();
  return signer.sign(key, "base64");
}

export function safeSegment(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  return /^[a-zA-Z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

export function hostFromUrl(value?: string | null): string {
  if (!value) return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  }
}

export function normalizeSystemType(value?: string | null): string {
  const raw = (value || "").toLowerCase();
  if (raw.includes("qiang") || raw.includes("强智")) return "QIANGZHI";
  if (raw.includes("kingo") || raw.includes("青果")) return "KINGOSOFT";
  if (raw.includes("qidi") || raw.includes("启迪")) return "QIDI";
  if (raw.includes("zf") || raw.includes("zheng") || raw.includes("正方")) return "ZF";
  return "UNKNOWN";
}

export function parserForSystem(systemType: string): string {
  switch (normalizeSystemType(systemType)) {
    case "QIANGZHI":
      return "qiangzhi.js";
    case "KINGOSOFT":
      return "kingosoft.js";
    default:
      return "zhengfang.js";
  }
}

export function scriptId(category: string, name: string): string {
  return `${category}.${name.replace(/\.js$/i, "")}`;
}

export function scriptPath(category: string, name: string): string {
  const safeCategory = safeSegment(category);
  const safeName = safeSegment(name);
  if (!safeCategory || !safeName) throw new Error("invalid script path");
  return path.join(config.scriptOutputDir, safeCategory === "parsers" ? safeName : safeName);
}

export function readFileIfExists(file: string): string | null {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function limitString(value: unknown, max = 1000): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
