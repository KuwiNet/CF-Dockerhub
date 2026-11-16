# CF-Dockerhub · Docker / OCI 镜像仓库代理

基于 Cloudflare Workers 的镜像仓库反向代理：国内直接拉取 Docker Hub / GHCR / Quay / GCR / NVCR 等仓库的镜像，同时支持多仓库路由、首页伪装与健康检查。

代码为 **module 语法** 单文件 Worker（`worker.js`），无需构建、无 npm 依赖。

## 特性

- **多仓库支持**：`docker.io`（默认）、`quay.io`、`gcr.io`、`registry.k8s.io`、`ghcr.io`、`nvcr.io`、`docker.cloudsmith.io`；可通过子域名、`?hubhost=` 参数或 `ROUTES` 环境变量扩展。
- **认证链路完整**：401 挑战（`Www-Authenticate`）里的 `realm` 会被改写回本 Worker，token 请求再按 `realm` 转发到上游真正的认证服务（`auth.docker.io` / `ghcr.io` / `quay.io/v2/auth` …）。私有仓库、`docker login` 均可用。
- **断点续传**：透传 `Range` / `If-None-Match`，blob 支持 `206 Partial Content`，断线重摇不会再从头下载。
- **大层流式转发**：响应体直接流式返回，不在 Worker 内存里落地；可选 `BLOB_REDIRECT=1` 把上游 307 原样回给客户端，省掉 Worker 流量。
- **首页伪装 / 搜索页**：`URL=nginx` 返回 nginx 默认页，`URL302` 直接跳转，默认加载镜像搜索页；Cookie、CSP、Set-Cookie 等敏感头会被清理。
- **可观测**：`/_health` 返回版本与当前上游；错误统一返回 Registry v2 规范的 JSON。

## 部署

### 方式一：Wrangler（推荐）

```bash
npm i -g wrangler
wrangler login
wrangler deploy          # 读取仓库里的 wrangler.toml
```

绑定自定义域名：在 `wrangler.toml` 里取消 `routes` 注释，或在 Cloudflare 控制台
`Workers & Pages → 你的 Worker → Settings → Domains & Routes` 里添加 Custom Domain。

> 替换已有部署时注意：`wrangler.toml` 里的 `name` 必须和线上那个 Worker 的服务名一致，
> 否则 `wrangler deploy` 会新建一个 Worker，而 Custom Domain 仍然指在旧 Worker 上，
> 表现为"代码推上去了但线上没变化"。

上线前先注入上游账号（不要让凭据进仓库）：

```bash
wrangler secret put DOCKER_AUTH     # 粘贴 user:password 或 user:PAT
```

### 方式二：控制台粘贴

`Workers & Pages → Create → Worker`，把 `worker.js` 全文粘贴进编辑器，`Deploy`。

> 注意：**不要再把域名做成指向源站的 DNS 记录**。Custom Domain 由 Cloudflare 自己托管证书；
> 如果 DNS 记录指向自有服务器而源站证书无效，会出现 `Error 526: Invalid SSL certificate`，表现就是拉不动镜像。

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
- **拉取大镜像超时**：把 `BLOB_REDIRECT` 设为 `1`，让客户端直连 CDN，Worker 只负责鉴权与 manifest。
- **私有仓库 401 循环**：确认 `AUTH_HOSTS`/`ROUTES` 覆盖了该仓库的认证主机（例如自建 Harbor 需要在 `ROUTES`
  里加映射，并把其 token 主机加入 `AUTH_HOSTS`）。
- **`docker search` 不可用**：`/v1/search` 是 Docker Hub 早已下线的旧 Web API，代理已按规范转发，
  但上游现在直接返回 404，这是上游行为，不是代理故障；`docker pull` 不受影响。

## 版本

- `2.2.0` — 新增 `DOCKER_AUTH` 上游账号注入（绕开 Docker Hub 匿名 IP 限流 429）与 `CACHE_TTL` 边缘缓存（匿名请求的 manifest/blob 走 Cache API）。
- `2.1.0` — 认证端点通用化、去掉 %3A 改写、重定向内部跟随、首页与健康检查、配置全部环境变量化。
- `1.0` — 初版（docker-proxy 模板）。

## 许可

MIT，见 [LICENSE](LICENSE)。
