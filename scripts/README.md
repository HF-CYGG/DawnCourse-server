# scripts/

## gen-script-meta.mjs — 静态脚本签名边车生成器

### 背景

生产环境由宿主机 1Panel/OpenResty 的 Stream 入口独占 `yyh163.xyz:10000`，通过
`ssl_preread` 区分协议：老客户端的 HTTP 直接转发到 `127.0.0.1:15000`，新客户端的
TLS 则透传到独立的 `127.0.0.1:10443` HTTPS 站点终止证书，再反向代理到同一
`15000` 上游。已有的 `yyh163.xyz:443` 网站不参与更新链路，也不需要修改。因此
Compose 只暴露容器的 `15000`，不再直接映射宿主机 `10000`。
`version.json.type` 必须始终使用老客户端可识别的 `standard`、`bugfix`、`security`、
`feature` 或 `major`，不能依赖国内网络访问 GitHub 才能完成正常更新。

脚本正文仍由 nginx 的**纯静态**下载路径提供（`try_files`，从不反代到
`llm-backend`）。客户端下载脚本正文后，会再取同目录的 `<name>.meta.json`，用其中的
`sha256` + `RSA-SHA256` 签名验签；**取不到 meta 就把云端脚本整个丢弃**，回落到 App
内置的 assets 旧版本，并弹「云端脚本拉取失败」。

因此 `html/scripts/{js,parsers,runtime}/` 下每个 `*.js` 都必须有一个同名、可验签的
`*.meta.json` 边车。本脚本负责生成 / 校验它们。

### 边车格式

```json
{
  "sha256": "<脚本原始字节的 hex sha256>",
  "signature": "<对同样字节做 RSA-SHA256 的 base64 签名>",
  "alg": "rsa-sha256",
  "version": <正整数，取自脚本头部注释 @version，缺省 1>
}
```

字段与取值和客户端 `ScriptSyncRepositoryImpl.parseScriptMeta` / `verifyScript` 完全对齐。
客户端按 **nginx 实际下发的原始字节** 计算 sha256 与验签，所以：

- 被签名的 `*.js` 与 `*.meta.json` 必须全平台字节一致：仓库 `.gitattributes` 已固定为
  `eol=lf`、无 BOM；`--check` 会额外拒绝 CRLF / BOM。

### 密钥

- **验签公钥**：`scripts/script_sign_public.pem`，随仓库提交，等于 App 内置的
  `SCRIPT_VERIFY_PUBLIC_KEY`。是边车校验的锚点，`--check` 只需要它。
- **签名私钥**（重新生成边车时才需要）解析顺序：
  1. `SCRIPT_SIGN_PRIVATE_KEY`（PEM，`\n` 转义会被还原）
  2. `SCRIPT_SIGN_KEY`（兼容 compose 现有变量名）
  3. `${SCRIPT_OUTPUT_DIR:-/shared/parsers}/keys/script_sign_private.pem`
  4. `data/parsers/keys/script_sign_private.pem`（本地开发）
- 重新生成时会校验「私钥导出的公钥 == 验签公钥」，不配对直接报错，避免签出 App 无法
  验证的边车。

### 用法

```bash
# 改完某个脚本后重新生成边车（本地）
node scripts/gen-script-meta.mjs

# 只校验：边车缺失 / 与脚本不匹配 / 签名不过 / .js 含 CRLF 或 BOM → 退出码 1（CI）
node scripts/gen-script-meta.mjs --check

# 单元测试
node --test scripts/gen-script-meta.test.mjs

# 更新元数据与生产端口兼容契约
node --test scripts/version-contract.test.mjs
```

- `--fill-stale`：容器 `start.sh` 启动时调用。只补齐**缺失或 sha256 对不上**的边车，
  已匹配的保持原签名不动，避免用运行期随机密钥覆盖镜像里用正确密钥签好的静态边车。
- `--root <dir>`：可重复，覆盖默认的 `html/scripts/{js,parsers,runtime}`。

### 相关改动

- `.gitattributes`：固定脚本与边车为 LF。
- `start.sh`：启动 nginx 前跑 `--fill-stale`，覆盖持久卷 `/shared/parsers` 里被
  管理端上传 / LLM 修复覆盖过的脚本。
- `Dockerfile`：`COPY ./scripts /app/scripts`。
- `.github/workflows/script-meta-check.yml`：PR / push 跑单测 + `--check`。
