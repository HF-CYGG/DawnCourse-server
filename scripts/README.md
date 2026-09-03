# scripts/

## gen-script-meta.mjs — 静态脚本签名边车生成器

### 背景

线上服务端**没有 TLS**（nginx 只 `listen 80` / `15000`，compose 映射 `10000:80`）。
Android 客户端把 `https://…:10000` 当主端点、manifest 查询又是 HTTPS 专用，于是所有
HTTPS 请求 TLS 握手失败，只能回落到

```
http://…:10000/scripts/<category>/<name>.js
```

这条**纯静态**下载路径（nginx `try_files`，从不反代到 `llm-backend`，所以数据库里的
签名与 manifest 对这个客户端不可达）。客户端下载脚本正文后，会再取同目录的
`<name>.meta.json`，用其中的 `sha256` + `RSA-SHA256` 签名验签；**取不到 meta 就把
云端脚本整个丢弃**，回落到 App 内置的 assets 旧版本，并弹「云端脚本拉取失败」。

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
