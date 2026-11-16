# CF-Dockerhub · Docker / OCI 镜像仓库代理

基于 Cloudflare Workers 的镜像仓库反向代理：国内直接拉取 Docker Hub / GHCR / Quay / GCR / NVCR 等仓库的镜像，同时支持多仓库路由、首页伪装与健康检查。

代码为 **module 语法** 单文件 Worker（`worker.js`），无需构建、无 npm 依赖。

## 特性

- **多仓库支持**：`docker.io`（默认）、`quay.io`、`gcr.io`、`registry.k8s.io`、`ghcr.io`、`nvcr.io`、`docker.cloudsmith.io`；可通过子域名、`?hubhost=` 参数或 `ROUTES` 环境变量扩展。
- **认证链路完整**：401 挑战（`Www-Authenticate`）里的 `realm` 会被改写回本 Worker，token 请求再按 `realm` 转发到上游真正的认证服务（`auth.docker.io` / `ghcr.io` / `quay.io/v2/auth` …）。私有仓库、`docker login` 均可用。
- **断点续传**：透传 `Range` / `If-None-Match`，blob 支持 `206 Partial Content`，断线重摇不会再从头下载。
- **大层流式转发**：响应体直接流式返回，不在 Worker 内存里落地；可选 `BLOB_REDIRECT=1` 把上游 307 原样回给客户端，省掉 Worker 流量。
- **绕开匿名限流**：`DOCKER_AUTH` 让匿名客户端用 Worker 自己的 Docker Hub 账号换 token；`CACHE_TTL` 让 manifest/blob 走边缘缓存。
- **首页伪装 / 搜索页**：`URL=nginx` 返回 nginx 默认页，`URL302` 直接跳转，默认加载镜像搜索页；Cookie、CSP、Set-Cookie 等敏感头会被清理。
- **可观测**：`/_health` 返回版本、当前上游与实际生效的对外地址；错误统一返回 Registry v2 规范的 JSON。

## 部署

### 方式一：Wrangler（手动）

```bash
npm i -g wrangler
wrangler login
wrangler deploy          # 读取仓库里的 wrangler.toml
```

绑定自定义域名：在 `wrangler.toml` 里取消 `routes` 注释，或在 Cloudflare 控制台
`Workers & Pages → 你的 Worker → Settings → Domains & Routes` 里添加 Custom Domain。

> 替换已有部署时注意：`wrangler.toml` 里的 `name` 必须和线上那个 Worker 的服务名一致，
> 否则 `wrangler deploy` 会新建一个 Worker，而 Custom Domain 仍指在旧 Worker 上，
> 表现为"代码推上去了但线上没变化"。

上线前先注入上游账号（不要让凭据进仓库）：

```bash
wrangler secret put DOCKER_AUTH     # 粘贴 user:password 或 user:PAT
```

### 方式二：控制台粘贴

`Workers & Pages → Create → Worker`，把 `worker.js` 全文粘贴进编辑器，`Deploy`。

> 注意：**不要再把域名做成指向源站的 DNS 记录**。Custom Domain 由 Cloudflare 自己托管证书；
> 如果 DNS 记录指向自有服务器而源站证书无效，会出现 `Error 526: Invalid SSL certificate`，表现就是拉不动镜像。

### 方式三：GitHub 仓库自动部署（Workers Builds，推荐）

push 到 `main` 就自动构建并部署，不用再手动 `wrangler deploy`：

1. `Workers & Pages` → 选中**已有那个 Worker**（例如 `docker`）→ `Settings` → `Builds` → `Connect`
2. 授权 Cloudflare 的 GitHub App（Repository access 里只勾这个仓库即可），选仓库与分支 `main`
3. 构建命令留空，部署命令 `npx wrangler deploy`，保存
4. 提交一次 push 触发第一次构建，`Deployments → View build history` 看日志

两个硬性注意点：

- `wrangler.toml` 的 `name` 必须**与面板里 Worker 的服务名逐字符一致**，否则构建直接失败（Cloudflare 会在构建后尝试自动开 PR 修这个问题，但首次构建仍然会失败）。本仓库当前填的是 `docker`，若你的服务名不同，改这一行即可。
- `DOCKER_AUTH` 是 secret，不是变量；连了 Builds 之后它仍然存在，也不会被构建覆盖。

不想用 Cloudflare 侧集成时，也可以在仓库里放 GitHub Actions（`cloudflare/wrangler-action@v4`），
把 `CLOUDFLARE_API_TOKEN`（Edit Cloudflare Workers 权限）与 `CLOUDFLARE_ACCOUNT_ID` 存成 repo secret 即可。

## 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `ROUTES` | 扩展/覆盖子域名到上游的映射（JSON） | `{"myreg":"registry.example.com"}` |
| `UA` | 追加屏蔽的爬虫 UA，逗号分隔 | `netcraft,somebot` |
| `URL` | 首页行为：`nginx` 返回伪装页；其他值则反代该地址 | `nginx` |
| `URL302` | 首页 302 跳转地址，优先级高于 `URL` | `https://example.com` |
| `HOME_PAGE_URL` | 首页展示的镜像搜索页，默认 `https://kuwinet.github.io/d-proxy` | |
| `CACHE_TTL` | manifest/blob 边缘缓存秒数，`0` 关闭。只缓存匿名请求（token 无 `sub`）的响应，私有镜像不会进缓存 | `3600` |
| `DOCKER_AUTH` | 上游 Docker Hub 账号，`user:password`（或用 PAT 代替密码）。匿名客户端会用它换 token，绕开按 IP 计的匿名限流 | `someuser:dckr_pat_xxx` |
| `BLOB_REDIRECT` | `1` 时 blob 307 直接交给客户端，Worker 不中转大流量 | `1` |
| `AUTH_HOSTS` | 追加允许的 token 端点主机，逗号分隔 | `auth.example.com` |
| `DOCKER_AUTH_HOSTS` | `DOCKER_AUTH` 生效的上游认证主机，默认 `auth.docker.io,auth.docker.com` | `auth.docker.io` |
| `PREFIX` | 路由前缀，默认空 | `/docker` |
| `PUBLIC_HOST` | 对外域名。Worker 前面还有一层 CDN（如 EdgeOne）回源时，realm 必须写成对外域名，否则客户端会去连源站域名 | `docker.example.com` |

## 客户端用法

```bash
# 直接用
docker pull docker.example.com/library/nginx:latest
docker pull docker.example.com/snowdreamtech/frpc:latest

# 多仓库：子域名方式（DNS 里把 ghcr.example.com 也指到同一个 Worker）
docker pull ghcr.example.com/stefanprodan/podinfo:6.4.0
# 或参数方式
docker pull docker.example.com/stefanprodan/podinfo:6.4.0?hubhost=ghcr.io
```

全局镜像加速（Linux）：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://docker.example.com"]
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

containerd（`/etc/containerd/config.toml`）：

```toml
[plugins."io.containerd.grpc.v1.cri".registry.mirrors]
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
    endpoint = ["https://docker.example.com"]
```

## 接入 EdgeOne 加速（可选，改善国内访问）

拓扑：EdgeOne 只在前面做加速与缓存，真正干活（改写 401 挑战、换 token、流式转发、边缘缓存）仍然是这个 Worker。

```
docker.example.com ──CNAME──► EdgeOne 国内节点 ──回源──► cf.example.com（本 Worker 的 Custom Domain）
```

### 前置条件（硬门槛）

- **ICP 备案**：EdgeOne 加速区域选「中国大陆可用区」或「全球可用区」时，加速域名必须已完成工信部 ICP 备案；
  未备案只能选「全球可用区（不含中国大陆）」，对国内速度帮助有限。
- **流量额度**：EdgeOne 个人版仅 50 GB 加速流量，而一个 `nginx:latest` 首拉就约 180 MB，
  缓存镜像会很快用满额度，需要按实际拉取量选套餐。
- **别把本 Worker 搬到 EdgeOne 边缘函数**：边缘函数请求 body 上限 1 MB（`docker push` 直接不支持）、
  CPU 时间 200 ms、内存 128 MB，不适合承载 registry 代理。

### 步骤

1. 给 Worker 再加一个**源站域名**（例 `cf.example.com`）作为 EdgeOne 的回源目标；原域名交给 EdgeOne 的 CNAME。
2. Worker 里加环境变量 `PUBLIC_HOST=docker.example.com`（对外域名）。这样即使 EdgeOne 回源时 Host 是 `cf.example.com`，
   401 挑战里的 `realm` 也会写成 `https://docker.example.com/_token?...`，docker 客户端后续请求仍走 EdgeOne。
3. EdgeOne 添加站点 → 填加速域名 → 源站类型「域名」，源站地址填 `cf.example.com`，端口 443 / HTTPS，
   **回源 Host 选「使用源站域名」**。
4. EdgeOne 规则引擎里配缓存（digest 索引的 blob 天然不可变，可以放心长缓存）：

| 匹配 | 节点缓存 TTL | 说明 |
| --- | --- | --- |
| 路径前缀 `/v2/` 且包含 `/blobs/sha256:` | 30 天 + 强制缓存 | 内容按 digest 索引，不会变 |
| 路径前缀 `/v2/` 且包含 `/manifests/` | 5~60 分钟（或 0 不缓存） | tag 可能被覆盖，按 `digest` 拉的客户端不受影响 |
| `/_token`、`/v2/`（裸路径） | 不缓存 | 需要每次回源拿挑战与 token |

5. 校验：

```bash
curl -s https://docker.example.com/_health      # 应显示 "base":"https://docker.example.com"
curl -sI https://docker.example.com/v2/         # 401 + realm 指向 docker.example.com
python3 test/smoke.py https://docker.example.com --e2e
```

> 回源 Host 如果填成「使用加速域名」，Cloudflare 侧会因为 Host 与 Worker 路由不匹配而报错，
> 记得用「使用源站域名」+ `PUBLIC_HOST` 这一组搭配。

## 自检

```bash
curl -sI https://docker.example.com/_health            # 200 + JSON
curl -s  https://docker.example.com/v2/                # 401 + Www-Authenticate: Bearer realm=".../_token?realm=..."
```

`/v2/` 返回 401 且 `realm` 指向本域名，说明认证链路是通的（401 是 Registry v2 规范要求的正常响应，
不是故障）。

`test/smoke.py` 是完整的拉取自检脚本（无第三方依赖）：

```bash
python3 test/smoke.py https://docker.example.com
python3 test/smoke.py https://docker.example.com --e2e     # 真实下载并校验 digest
```

## 常见问题

- **`Error 526: Invalid SSL certificate`**：域名没有由 Worker 提供，Cloudflare 回源到了证书无效的服务器。
  检查 `Domains & Routes` 是否还绑着这个域名，以及是否存在冲突的 DNS 记录。
- **`429 TOOMANYREQUESTS`（`You have reached your unauthenticated pull rate limit`）**：这是 Docker Hub 对**出口 IP**
  的匿名拉取限制，不是本代理的 bug。匿名 token 里的额度写得很明确：`pull_limit 100 / 21600s`（6 小时 100 次），
  而 Cloudflare Worker 的出口 IP 是共享地址段，公共镜像站几乎必然被打满，此时所有人都是 429。
  两个解法：① 给 Worker 配 `DOCKER_AUTH`（推荐，全站生效）；② 客户端 `docker login <你的代理域名>`，
  Worker 会透传 `Authorization`，用你自己的账号额度。另外把 `CACHE_TTL` 打开能显著减少回源的 manifest 请求，
  进一步降低触发 429 的概率。
- **Workers Builds 构建失败，提示 wrangler 名称不一致**：`wrangler.toml` 的 `name` 必须等于面板里 Worker 的服务名
  （例如 `docker`），改完再 push。
- **拉取大镜像超时**：把 `BLOB_REDIRECT` 设为 `1`，让客户端直连 CDN，Worker 只负责鉴权与 manifest。
- **私有仓库 401 循环**：确认 `AUTH_HOSTS`/`ROUTES` 覆盖了该仓库的认证主机（例如自建 Harbor 需要在 `ROUTES`
  里加映射，并把其 token 主机加入 `AUTH_HOSTS`）。
- **`docker search` 不可用**：`/v1/search` 是 Docker Hub 早已下线的旧 Web API，代理已按规范转发，
  但上游现在直接返回 404，这是上游行为，不是代理故障；`docker pull` 不受影响。
- **接在 EdgeOne 后面 realm 指向了源站域名**：忘了设 `PUBLIC_HOST`，或 EdgeOne 回源 Host 用了「使用加速域名」。

## 版本

- `2.3.0` — 新增 `PUBLIC_HOST`（Worker 前面挂 CDN/反向代理时，realm 仍指向对外域名）；`/_health` 回显实际生效的对外地址；README 补 Workers Builds 自动部署与 EdgeOne 接入。
- `2.2.0` — 新增 `DOCKER_AUTH` 上游账号注入（绕开 Docker Hub 匿名 IP 限流 429）与 `CACHE_TTL` 边缘缓存（匿名请求的 manifest/blob 走 Cache API）。
- `2.1.0` — 认证端点通用化、去掉 %3A 改写、重定向内部跟随、首页与健康检查、配置全部环境变量化。
- `1.0` — 初版（docker-proxy 模板）。

## 许可

MIT，见 [LICENSE](LICENSE)。
