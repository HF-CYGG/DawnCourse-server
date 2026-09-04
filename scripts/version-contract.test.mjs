/**
 * 文件说明：锁定应用更新元数据与生产反向代理的兼容契约。
 *
 * 老客户端使用固定枚举解析 type，未知值会被 Gson 解析为 null；生产环境的公网
 * 10000 端口则由 1Panel/OpenResty 负责 TLS，容器不得再次占用该端口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** 当前测试文件所在目录。 */
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
/** server 仓库根目录。 */
const serverRoot = path.resolve(scriptDirectory, "..");
/** 所有已发布老客户端都能识别的更新类型。 */
const legacyCompatibleUpdateTypes = new Set([
  "standard",
  "bugfix",
  "security",
  "feature",
  "major",
]);

test("version.json 使用老客户端可识别的更新类型", () => {
  /** 当前准备发布的更新元数据。 */
  const versionMetadata = JSON.parse(
    fs.readFileSync(path.join(serverRoot, "version.json"), "utf8"),
  );

  assert.ok(
    legacyCompatibleUpdateTypes.has(versionMetadata.type),
    `不兼容的更新类型：${String(versionMetadata.type)}`,
  );
});

test("Compose 为宿主机 TLS 反向代理保留公网 10000 端口", () => {
  /** 生产 Compose 配置文本。 */
  const composeSource = fs.readFileSync(
    path.join(serverRoot, "docker-compose.yml"),
    "utf8",
  );
  /** 匹配会占用宿主机 10000 的 Compose 短端口语法。 */
  const publicUpdatePortBinding = /^\s*-\s*["']?(?:[^\s"']+:)?10000:\d+/mu;

  assert.doesNotMatch(
    composeSource,
    publicUpdatePortBinding,
    "宿主机 10000 必须留给 1Panel/OpenResty 终止 TLS",
  );
});

test("1Panel Stream 在同一公网端口分别转发 HTTP 与 TLS", () => {
  /** 交给 1Panel/OpenResty Stream 上下文加载的配置模板。 */
  const streamConfigPath = path.join(
    serverRoot,
    "deploy",
    "1panel",
    "dawn-update-stream.conf",
  );

  assert.ok(fs.existsSync(streamConfigPath), "缺少 1Panel 双协议 Stream 配置");

  /** 双协议分流配置文本。 */
  const streamConfig = fs.readFileSync(streamConfigPath, "utf8");
  assert.match(streamConfig, /\$ssl_preread_protocol/u);
  assert.match(streamConfig, /""\s+127\.0\.0\.1:15000;/u);
  assert.match(streamConfig, /default\s+127\.0\.0\.1:443;/u);
  assert.match(streamConfig, /listen\s+10000;/u);
  assert.match(streamConfig, /ssl_preread\s+on;/u);
});
