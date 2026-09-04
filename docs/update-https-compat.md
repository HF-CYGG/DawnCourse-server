# 更新服务 HTTPS 与老版本兼容部署

## 目标

- 新客户端直接访问 `https://yyh163.xyz:10000/version.json`。
- 老客户端直接访问固定的 `http://yyh163.xyz:10000/version.json`，不依赖 GitHub 可用性。
- 新老客户端从自建服务取得同一份兼容元数据，不会收到无法识别的更新类型。
- TLS 证书只由宿主机 1Panel/OpenResty 管理，不进入仓库或应用容器。

## 服务边界

生产链路固定为：

```text
旧版 Android HTTP :10000  -> 1Panel/OpenResty Stream -> 127.0.0.1:15000
新版 Android HTTPS :10000 -> 1Panel/OpenResty Stream -> 127.0.0.1:10443
                                                       -> 127.0.0.1:15000
```

`docker-compose.yml` 不得映射宿主机 `10000`，否则 OpenResty 无法监听该端口。容器的
`15000` 是反向代理上游；`8080` 仅保留给本机调试或运维访问。

## 1Panel 配置

1. 保持已有的 `yyh163.xyz:443` 网站不变，创建一个仅供更新入口内部转发使用的 HTTPS
   反向代理网站：主域名填写 `yyh163.xyz:10443`，代理地址填写
   `http://127.0.0.1:15000`，选择现有 `yyh163.xyz` 证书，只启用 TLS 1.2 与 TLS 1.3。
   HTTP 选项选择“禁止 HTTP 访问”，不要选择自动跳转；HSTS 暂时关闭。
2. 在新网站的配置文件中确认存在 `listen 10443 ssl;`，并且没有把请求重定向到 443。
   在服务器上执行以下命令，确认独立 TLS 上游返回 HTTP 200 和兼容元数据：

   ```bash
   curl --resolve yyh163.xyz:10443:127.0.0.1 \
     https://yyh163.xyz:10443/version.json
   ```

3. 停止或删除当前监听 `yyh163.xyz:10000` 的 HTTP 网站，释放 OpenResty 的 `10000`。
   不要保留该网站的“HTTP 自动跳转 HTTPS”，因为它会截获老客户端请求。
4. 在 OpenResty 容器终端确认编译参数包含 `--with-stream_ssl_preread_module`：

   ```bash
   (openresty -V 2>&1 || nginx -V 2>&1) | grep -- --with-stream_ssl_preread_module
   ```

5. 在 1Panel 创建 TCP 代理并监听 `10000`，然后把生成的 Stream 配置改为
   `deploy/1panel/dawn-update-stream.conf` 的内容。若直接编辑 OpenResty 全局配置，应把
   该文件内容放进已有的 `stream {}` 中，不要再嵌套一层 `stream`。
6. 先执行 OpenResty 配置检查，再保存并重载。TCP 代理只识别和转发协议，不持有证书；
   TLS 会原样透传到步骤 1 的 `10443` 站点。

如果 OpenResty 运行在隔离的桥接网络中，配置里的 `127.0.0.1` 必须换成 OpenResty
容器能够访问的宿主机网关地址。`10443` 与 Stream 都在同一 OpenResty 实例时可以继续
使用 `127.0.0.1:10443`；不得把它指回公网 `10000`，否则会形成代理环路。

## 更新元数据兼容契约

`version.json` 的 `type` 只能使用：

- `standard`
- `bugfix`
- `security`
- `feature`
- `major`

禁止使用 `patch`。老客户端的 Gson 会把未知枚举解析为 `null`，随后在更新弹窗读取
标签时崩溃。CI 通过 `node --test scripts/version-contract.test.mjs` 锁定该契约。

## 上线验证

```bash
curl --fail --show-error --silent \
  https://yyh163.xyz:10000/version.json

curl --resolve yyh163.xyz:10443:127.0.0.1 \
  https://yyh163.xyz:10443/version.json

curl --head --max-redirs 0 \
  http://yyh163.xyz:10000/version.json
```

验收标准：

1. HTTPS 请求通过证书校验并返回 HTTP 200。
2. HTTPS JSON 中 `type` 是上述兼容值，当前发布应为 `standard`。
3. HTTP 请求直接返回 HTTP 200，且与 HTTPS 返回相同版本及兼容 `type`。
4. GitHub Raw 仅作为灾难兜底，不作为国内用户正常更新链路的前置条件。

## 回滚

若 Stream 配置导致 OpenResty 无法重载，删除新增的 `10000` Stream 片段并恢复配置检查。
恢复原 `yyh163.xyz:10000` 网站即可；独立的 `10443` 站点可以保留供排查，也可以在确认
回滚后停用。容器上游始终保留在 `15000`，回滚不需要修改数据库或重建后端数据卷。
