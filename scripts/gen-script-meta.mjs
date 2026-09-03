#!/usr/bin/env node
/**
 * 为 html/scripts/{js,parsers,runtime}/ 下的每个 *.js 生成同名 *.meta.json 签名边车。
 *
 * 为什么需要它：
 *   线上服务端没有 TLS，Android 客户端所有 HTTPS 请求握手失败，只能回落到
 *   http://…:10000/scripts/<category>/<name>.js 的「静态文件下载」路径。客户端拿到
 *   脚本正文后会去取同名 <name>.meta.json，用其中的 sha256 + RSA-SHA256 签名验签；
 *   取不到 meta 就把云端脚本整个丢弃并弹「云端脚本拉取失败」。nginx 对
 *   /scripts/{js,parsers}/* 是纯静态 try_files，从不反代到 llm-backend，所以 DB 里的
 *   签名用不上——必须在磁盘上把 .meta.json 放到 .js 旁边。
 *
 * 字节一致性：
 *   客户端按 nginx「实际下发的原始字节」做 sha256 与验签，因此这里也必须对
 *   .js 的原始磁盘字节签名。仓库已用 .gitattributes 固定这些文件为 LF、无 BOM；
 *   --check 模式会额外拒绝 CRLF / BOM，避免跨平台构建出不一致的镜像。
 *
 * 用法：
 *   node scripts/gen-script-meta.mjs [--root <dir>]... [--check|--fill-stale] [--quiet]
 *     （默认）用私钥重签所有脚本，适合改完脚本后在本地重新生成边车
 *     --check       只校验，不需要私钥：对每个 .js 校验同名边车的 sha256、
 *                   RSA-SHA256 签名（用公钥验）、alg、version，以及 .js 无 CRLF/BOM。
 *                   任一不满足 → 退出码 1。CI 用。
 *     --fill-stale  容器启动用：仅当边车缺失、或其签名【验不过当前验签公钥】时才用私钥重写
 *                   （能验过的保持不动，避免用运行期密钥覆盖镜像里已签好的静态边车）。
 *                   这会覆盖持久卷 /shared/parsers 里旧版服务端用旧密钥写的 *.meta.json。
 *     --quiet       只打印告警与错误
 *
 * 私钥解析顺序（重签 / --fill-stale 时需要，与 llm-backend/src/runtimeConfig.ts 一致）：
 *   1. env SCRIPT_SIGN_PRIVATE_KEY（\n 转义会被还原）
 *   2. env SCRIPT_SIGN_KEY（兼容 docker-compose 现有变量名）
 *   3. ${SCRIPT_OUTPUT_DIR:-/shared/parsers}/keys/script_sign_private.pem
 *   4. data/parsers/keys/script_sign_private.pem（本地开发）
 *
 * 公钥解析顺序（--check 时只需要它；重签时用于校验私钥配对）：
 *   1. env SCRIPT_VERIFY_PUBLIC_KEY
 *   2. scripts/script_sign_public.pem（随仓库提交，= App 内置 SCRIPT_VERIFY_PUBLIC_KEY）
 *   3. ${SCRIPT_OUTPUT_DIR:-/shared/parsers}/keys/script_sign_public.pem
 *   4. data/parsers/keys/script_sign_public.pem
 *   5. 由已解析到的私钥推导
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_PUBLIC_KEY_PATH = path.join(SCRIPT_DIR, "script_sign_public.pem");

const DEFAULT_ROOTS = ["html/scripts/js", "html/scripts/parsers", "html/scripts/runtime"];
const ALG = "rsa-sha256";

function normalizePem(value) {
  return (value || "").replace(/\\n/g, "\n").trim();
}

function normalizeSpki(pem) {
  return pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

function derivePublicKey(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString().trim();
}

/** 装载签名私钥（重签需要）。找不到返回 null。 */
export function loadSigningKey(env = process.env) {
  const envPrivate = normalizePem(env.SCRIPT_SIGN_PRIVATE_KEY || env.SCRIPT_SIGN_KEY);
  if (envPrivate) return { privateKey: envPrivate, source: "env:SCRIPT_SIGN_PRIVATE_KEY" };
  const outputDir = env.SCRIPT_OUTPUT_DIR || "/shared/parsers";
  for (const file of [
    path.join(outputDir, "keys/script_sign_private.pem"),
    path.join(REPO_ROOT, "data/parsers/keys/script_sign_private.pem")
  ]) {
    if (fs.existsSync(file)) return { privateKey: fs.readFileSync(file, "utf8"), source: file };
  }
  return null;
}

/** 装载验签公钥（--check 需要）。找不到返回 null。 */
export function loadVerifyKey(env = process.env, fallbackPrivateKey = null) {
  const envPublic = normalizePem(env.SCRIPT_VERIFY_PUBLIC_KEY);
  if (envPublic) return { publicKey: envPublic, source: "env:SCRIPT_VERIFY_PUBLIC_KEY" };
  const outputDir = env.SCRIPT_OUTPUT_DIR || "/shared/parsers";
  for (const file of [
    REPO_PUBLIC_KEY_PATH,
    path.join(outputDir, "keys/script_sign_public.pem"),
    path.join(REPO_ROOT, "data/parsers/keys/script_sign_public.pem")
  ]) {
    if (fs.existsSync(file)) return { publicKey: fs.readFileSync(file, "utf8"), source: file };
  }
  if (fallbackPrivateKey) return { publicKey: derivePublicKey(fallbackPrivateKey), source: "derived-from-private-key" };
  return null;
}

/** 从脚本头部注释解析 `@version <整数>`；取不到返回 1。 */
export function parseVersion(source) {
  const match = source.slice(0, 4000).match(/@version\s+(\d{1,9})/);
  if (!match) return 1;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** 对脚本原始字节计算 meta。bytes: Buffer。 */
export function computeMeta(bytes, privateKey) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(bytes);
  signer.end();
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    signature: signer.sign(privateKey, "base64"),
    alg: ALG,
    version: parseVersion(bytes.toString("utf8"))
  };
}

/** 序列化为客户端可解析的 JSON（2 空格缩进 + LF + 末尾换行）。 */
export function serializeMeta(meta) {
  return `${JSON.stringify({ sha256: meta.sha256, signature: meta.signature, alg: meta.alg, version: meta.version }, null, 2)}\n`;
}

/** 按客户端口径校验一份边车是否与脚本字节匹配。返回错误描述数组（空 = 通过）。 */
export function verifySidecar(bytes, sidecarText, publicKey) {
  const errors = [];
  let meta;
  try {
    meta = JSON.parse(sidecarText);
  } catch {
    return ["边车不是合法 JSON"];
  }
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (meta.sha256 !== sha) errors.push(`sha256 不符（边车 ${short(meta.sha256)} ≠ 脚本 ${short(sha)}）`);
  if (meta.alg !== ALG) errors.push(`alg 必须是 "${ALG}"，实际 "${meta.alg}"`);
  if (!Number.isInteger(meta.version) || meta.version <= 0) errors.push(`version 必须是正整数，实际 ${JSON.stringify(meta.version)}`);
  if (typeof meta.signature !== "string" || !meta.signature) {
    errors.push("signature 缺失");
  } else {
    let ok = false;
    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(bytes);
      verifier.end();
      ok = verifier.verify(publicKey, Buffer.from(meta.signature, "base64"));
    } catch (error) {
      errors.push(`验签抛错：${error.message}`);
    }
    if (!ok && !errors.some((item) => item.startsWith("验签抛错"))) errors.push("RSA-SHA256 签名验证不通过");
  }
  return errors;
}

function short(value) {
  return typeof value === "string" ? `${value.slice(0, 12)}…` : String(value);
}

function hasBom(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasCrlf(bytes) {
  return bytes.includes(0x0d);
}

function listScripts(rootAbs) {
  return fs
    .readdirSync(rootAbs)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(rootAbs, name));
}

function metaPathFor(rootAbs, jsPath) {
  return path.join(rootAbs, `${path.basename(jsPath).replace(/\.js$/, "")}.meta.json`);
}

function parseArgs(argv) {
  const roots = [];
  let check = false;
  let fillStale = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--fill-stale") fillStale = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root 需要一个目录参数");
      roots.push(value);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      roots.push(arg.slice("--root=".length));
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  if (check && fillStale) throw new Error("--check 与 --fill-stale 不能同时使用");
  return { roots: roots.length ? roots : DEFAULT_ROOTS, check, fillStale, quiet };
}

export function run(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd() } = {}) {
  const { roots, check, fillStale, quiet } = parseArgs(argv);
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const signing = check ? null : loadSigningKey(env);
  if (!check && !signing) {
    throw new Error(
      "找不到脚本签名私钥。请设置 SCRIPT_SIGN_PRIVATE_KEY，或提供 " +
        `${env.SCRIPT_OUTPUT_DIR || "/shared/parsers"}/keys/script_sign_private.pem`
    );
  }
  const verify = loadVerifyKey(env, signing?.privateKey || null);
  if (!verify) throw new Error(`找不到验签公钥（缺 ${path.relative(REPO_ROOT, REPO_PUBLIC_KEY_PATH)} 或 SCRIPT_VERIFY_PUBLIC_KEY）`);

  if (signing) {
    const derived = derivePublicKey(signing.privateKey);
    if (normalizeSpki(derived) !== normalizeSpki(verify.publicKey)) {
      throw new Error(
        `签名私钥（${signing.source}）与验签公钥（${verify.source}）不配对，` +
          "生成的边车 App 端会验签失败。请使用与 App 内置 SCRIPT_VERIFY_PUBLIC_KEY 对应的私钥。"
      );
    }
    log(`[gen-script-meta] 私钥：${signing.source}`);
  }
  log(`[gen-script-meta] 公钥：${verify.source}`);

  const problems = [];
  let written = 0;
  let scanned = 0;

  for (const root of roots) {
    const rootAbs = path.isAbsolute(root) ? root : path.resolve(cwd, root);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
      log(`[gen-script-meta] 跳过不存在的目录：${root}`);
      continue;
    }
    for (const jsPath of listScripts(rootAbs)) {
      scanned += 1;
      const rel = path.relative(cwd, jsPath);
      const bytes = fs.readFileSync(jsPath);
      const metaPath = metaPathFor(rootAbs, jsPath);
      const metaRel = path.relative(cwd, metaPath);
      const existing = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, "utf8") : null;

      if (check) {
        if (hasBom(bytes)) problems.push(`${rel}: 含 UTF-8 BOM，请去掉（客户端按原始字节验签）`);
        if (hasCrlf(bytes)) problems.push(`${rel}: 含 CRLF，请规范化为 LF（git add --renormalize / 检查 .gitattributes）`);
        if (existing === null) {
          problems.push(`${metaRel}: 缺失`);
        } else {
          for (const error of verifySidecar(bytes, existing, verify.publicKey)) problems.push(`${metaRel}: ${error}`);
        }
        continue;
      }

      const meta = computeMeta(bytes, signing.privateKey);
      const metaText = serializeMeta(meta);
      if (fillStale && existing !== null) {
        // 只有当现有边车能被验签公钥【真正验过】时才保留（避免用运行期密钥覆盖镜像里
        // 已用正确密钥签好的边车）；sha256 对得上但签名验不过的旧边车必须重写——
        // 例如持久卷里旧版服务端写的、用旧密钥签名的 *.meta.json。
        const stale = verifySidecar(bytes, existing, verify.publicKey);
        if (stale.length === 0) continue;
        log(`[gen-script-meta] 重写失效边车 ${metaRel}：${stale.join("；")}`);
      }
      if (existing !== metaText) {
        fs.writeFileSync(metaPath, metaText);
        written += 1;
        log(`[gen-script-meta] ${existing === null ? "新增" : "更新"} ${metaRel}  (v${meta.version}, sha ${short(meta.sha256)})`);
      }
    }
  }

  if (check) {
    if (problems.length) {
      console.error(`[gen-script-meta] --check 失败（${problems.length} 项）：`);
      for (const item of problems) console.error(`  - ${item}`);
      return 1;
    }
    log(`[gen-script-meta] --check 通过：${scanned} 个脚本的边车均与脚本字节匹配`);
    return 0;
  }

  log(`[gen-script-meta] 完成：扫描 ${scanned} 个脚本，写入 ${written} 个边车`);
  return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    process.exit(run());
  } catch (error) {
    console.error(`[gen-script-meta] 错误：${error.message}`);
    process.exit(1);
  }
}
