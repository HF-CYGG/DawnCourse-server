import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseVersion, computeMeta, serializeMeta, verifySidecar, run } from "./gen-script-meta.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const REPO_PUBLIC_KEY = fs.readFileSync(path.join(HERE, "script_sign_public.pem"), "utf8");

const kp = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

test("parseVersion 解析头部 @version，缺省 / 非法回落到 1", () => {
  assert.equal(parseVersion("// @version 12\nconsole.log(1)"), 12);
  assert.equal(parseVersion("/**\n * @version    7\n */"), 7);
  assert.equal(parseVersion("no marker here"), 1);
  assert.equal(parseVersion("// @version 0"), 1);
  assert.equal(parseVersion("// @version abc"), 1);
  assert.equal(parseVersion(`// @version 3${"\n".repeat(5000)}// @version 9`), 3);
});

test("computeMeta 的字段与客户端 parseScriptMeta 对齐", () => {
  const bytes = Buffer.from("// @version 5\nglobalThis.x = 1;\n", "utf8");
  const meta = computeMeta(bytes, kp.privateKey);
  assert.equal(meta.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(meta.alg, "rsa-sha256");
  assert.equal(meta.version, 5);
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(bytes);
  assert.equal(verifier.verify(kp.publicKey, Buffer.from(meta.signature, "base64")), true);
});

test("serializeMeta 输出 2 空格缩进、固定字段序、末尾换行", () => {
  const text = serializeMeta({ sha256: "aa", signature: "bb", alg: "rsa-sha256", version: 2 });
  assert.equal(text, '{\n  "sha256": "aa",\n  "signature": "bb",\n  "alg": "rsa-sha256",\n  "version": 2\n}\n');
});

test("verifySidecar 对完好边车返回空数组", () => {
  const bytes = Buffer.from("console.log('ok');\n", "utf8");
  const text = serializeMeta(computeMeta(bytes, kp.privateKey));
  assert.deepEqual(verifySidecar(bytes, text, kp.publicKey), []);
});

test("verifySidecar 捕获 sha256 不符 / 篡改", () => {
  const bytes = Buffer.from("console.log('ok');\n", "utf8");
  const text = serializeMeta(computeMeta(bytes, kp.privateKey));
  const tampered = Buffer.from("console.log('evil');\n", "utf8");
  const errors = verifySidecar(tampered, text, kp.publicKey);
  assert.ok(errors.some((e) => e.includes("sha256 不符")));
  assert.ok(errors.some((e) => e.includes("签名验证不通过")));
});

test("verifySidecar 捕获 alg / version / 非法 JSON / 缺签名", () => {
  const bytes = Buffer.from("x\n", "utf8");
  const good = computeMeta(bytes, kp.privateKey);
  assert.deepEqual(verifySidecar(bytes, "{ not json", kp.publicKey), ["边车不是合法 JSON"]);
  assert.ok(
    verifySidecar(bytes, serializeMeta({ ...good, alg: "hmac-sha256" }), kp.publicKey).some((e) => e.includes("alg"))
  );
  assert.ok(
    verifySidecar(bytes, serializeMeta({ ...good, version: 0 }), kp.publicKey).some((e) => e.includes("version"))
  );
  assert.ok(
    verifySidecar(bytes, JSON.stringify({ sha256: good.sha256, alg: "rsa-sha256", version: 1 }), kp.publicKey).some((e) =>
      e.includes("signature 缺失")
    )
  );
});

test("verifySidecar 用错误的公钥判定失败", () => {
  const bytes = Buffer.from("y\n", "utf8");
  const text = serializeMeta(computeMeta(bytes, kp.privateKey));
  const other = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  assert.ok(verifySidecar(bytes, text, other.publicKey).some((e) => e.includes("签名验证不通过")));
});

test("--fill-stale 会重写签名验不过的遗留边车（持久卷里旧密钥签的）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-meta-fillstale-"));
  try {
    const jsSrc = fs.readFileSync(path.join(REPO_ROOT, "html/scripts/js/generic_provider.js"));
    fs.writeFileSync(path.join(dir, "generic_provider.js"), jsSrc);
    // 旧版服务端遗留：sha256 字段正确，但签名是另一把密钥签的、字段也多
    const wrong = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const s = crypto.createSign("RSA-SHA256");
    s.update(jsSrc);
    fs.writeFileSync(
      path.join(dir, "generic_provider.meta.json"),
      JSON.stringify({
        scriptName: "generic_provider.js",
        version: 1,
        parentVersion: 0,
        parentSha256: "",
        sha256: crypto.createHash("sha256").update(jsSrc).digest("hex"),
        signature: s.sign(wrong.privateKey, "base64"),
        alg: "rsa-sha256"
      })
    );

    const code = run(["--fill-stale", "--quiet", "--root", dir], { env: {}, cwd: dir });
    assert.equal(code, 0);

    const rewritten = fs.readFileSync(path.join(dir, "generic_provider.meta.json"), "utf8");
    assert.deepEqual(verifySidecar(jsSrc, rewritten, REPO_PUBLIC_KEY), [], "重写后应能被 App 公钥验过");
    assert.deepEqual(Object.keys(JSON.parse(rewritten)), ["sha256", "signature", "alg", "version"]);

    // 幂等：再跑一次不应再改动
    const before = fs.statSync(path.join(dir, "generic_provider.meta.json")).mtimeMs;
    run(["--fill-stale", "--quiet", "--root", dir], { env: {}, cwd: dir });
    assert.deepEqual(
      verifySidecar(jsSrc, fs.readFileSync(path.join(dir, "generic_provider.meta.json"), "utf8"), REPO_PUBLIC_KEY),
      []
    );
    void before;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("仓库内已提交的静态边车能被提交的公钥验证（= App 内置公钥）", () => {
  const publicKey = fs.readFileSync(path.join(HERE, "script_sign_public.pem"), "utf8");
  const roots = ["html/scripts/js", "html/scripts/parsers", "html/scripts/runtime"];
  let count = 0;
  for (const root of roots) {
    const dir = path.join(REPO_ROOT, root);
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const bytes = fs.readFileSync(path.join(dir, name));
      assert.ok(!bytes.includes(0x0d), `${root}/${name} 含 CRLF`);
      const sidecarPath = path.join(dir, `${name.replace(/\.js$/, "")}.meta.json`);
      assert.ok(fs.existsSync(sidecarPath), `缺少边车 ${sidecarPath}`);
      assert.deepEqual(
        verifySidecar(bytes, fs.readFileSync(sidecarPath, "utf8"), publicKey),
        [],
        `${root}/${name} 边车校验失败`
      );
      count += 1;
    }
  }
  assert.equal(count, 19);
});
