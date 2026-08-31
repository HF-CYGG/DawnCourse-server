/**
 * 文件说明：锁定 Windows 本地启动脚本使用 TypeScript 编译入口，避免回退到遗留单文件服务。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const startBatUrl = new URL("../../start.bat", import.meta.url);

test("start.bat 先构建并启动 dist/main.js，不再执行遗留 server.js", () => {
  const source = fs.readFileSync(startBatUrl, "utf8");

  assert.match(source, /(?:call\s+)?npm\s+run\s+build/i);
  assert.match(source, /node\s+dist[\\/]main\.js/i);
  assert.doesNotMatch(source, /node\s+server\.js/i);
  assert.ok(source.search(/npm\s+run\s+build/i) < source.search(/node\s+dist[\\/]main\.js/i));
});
