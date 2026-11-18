/**
 * CF-Dockerhub — Docker / OCI 镜像仓库反向代理（Cloudflare Workers）
 *
 * 相比 v1（原 docker-proxy 模板）的主要改动：
 *   1. 认证令牌端点不再硬编码 auth.docker.io：401 响应里的 realm 会被改写到本 Worker 的
 *      /_token?realm=... ，因此 ghcr / gcr / quay / nvcr / k8s 等仓库的 token 也能正确转发。
 *   2. 去掉脆弱的 %3A / %2F 字符串替换：不再改写 query，也不会把 sha256 摘要改坏。
 *   3. registry 路径不再受 User-Agent 影响（浏览器访问 /v2/... 同样按 registry 处理）。
 *   4. 重定向（blob 307 到 CDN）在 Worker 内部跟随，且跳主机时自动丢弃 Authorization；
 *      可选 BLOB_REDIRECT=1 直接把 307 返回给客户端。
 *   5. 上游主机、屏蔽 UA、首页行为全部走环境变量，不再依赖模块级可变状态（避免并发串号）。
 *   6. 增加 /_health 健康检查、OPTIONS 预检、CORS 头、缓存策略与结构化错误。
 *   7. 首页 HTML 内置在 Worker 里（HOME_HTML），不再从 github.io 反代；
 *      资源（css / js / 字体 / logo）走 jsDelivr；commit 号集中在 ASSET_COMMIT 一个常量。
 *      设 BUILTIN_HOME=0 可回退。
 *   8. 导航高亮块改为纯 CSS（见 css/navbar.css 的 li.active>a 规则），不再靠 JS 测量定位。
 *
 * 环境变量（Cloudflare Workers → Settings → Variables）：
 *   ROUTES         JSON，覆盖/扩展子域名到上游仓库的映射，例如 {"myreg":"registry.example.com"}
 *   UA             追加要屏蔽的爬虫 UA，逗号分隔
 *   URL            首页行为："nginx" 返回伪装页；其他值则反代该地址
 *   URL302         首页 302 跳转地址（优先于 URL）
 *   HOME_PAGE_URL  回退时首页要反代的地址（默认 kuwinet.github.io/d-proxy，仅 BUILTIN_HOME=0 时使用）
 *   BUILTIN_HOME   默认 1：首页返回内置 HTML；设 0 回退到 HOME_PAGE_URL 反代
 *   CACHE_TTL      manifest/blob 的边缘缓存秒数（0 = 关闭）；只有匿名请求（无 Authorization，或匿名 token 无 sub）才缓存
 *   BLOB_REDIRECT  设为 1 时，blob 重定向原样返回 307 给客户端（不经过 Worker 流量）
 *   AUTH_HOSTS     追加允许作为 token 端点的主机，逗号分隔
 *   DOCKER_AUTH    上游 Docker Hub 账号，格式 user:password（或 user:PAT），匿名请求时用它换 token，
 *                  解决 Docker Hub 按出口 IP 计的 100 次/6 小时匿名限流（429 TOOMANYREQUESTS）
 *   PREFIX         路由前缀，默认空；例如挂在 example.com/docker/* 时设为 /docker
 *   PUBLIC_HOST    对外域名。Worker 前面还有一层 CDN（如 EdgeOne）时，realm 必须写成对外域名，
 *                  否则客户端会去连 CDN 后面的源站域名；例如 EdgeOne 回源 cf.example.com 时设 PUBLIC_HOST=docker.example.com
 */

const VERSION = '2.3.0'

/** 默认上游路由表：子域名首段 -> 上游仓库主机 */
const DEFAULT_ROUTES = {
    // 生产
    docker: 'registry-1.docker.io',
    'hub-docker': 'registry-1.docker.io',
    quay: 'quay.io',
    gcr: 'gcr.io',
    'k8s-gcr': 'gcr.io',
    k8s: 'registry.k8s.io',
    'registry-k8s': 'registry.k8s.io',
    ghcr: 'ghcr.io',
    cloudsmith: 'docker.cloudsmith.io',
    nvcr: 'nvcr.io',
    // 测试
    test: 'registry-1.docker.io',
}

const DEFAULT_REGISTRY = 'registry-1.docker.io'
const DEFAULT_HOME_PAGE_URL = 'https://kuwinet.github.io/d-proxy'

/** 静态资源版本：jsDelivr 固定 commit（换版本只改这一行） */
const ASSET_COMMIT = 'c974a785a06b1bc8b248998714bfee9ebb4aa06f'
const ASSET_CDN = 'https://cdn.jsdelivr.net/gh/KuwiNet/kuwinet.github.io@' + ASSET_COMMIT

/** 内置首页（原 d-proxy/index.html），资源引用统一走 ASSET_CDN */
const HOME_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>Docker Hub 镜像搜索</title>
    <meta charset="UTF-8">
    <link rel="shortcut icon" href="${ASSET_CDN}/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Bootstrap CSS -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.1/dist/css/bootstrap.min.css">
    <!-- Custom CSS -->
    <link href="${ASSET_CDN}/css/navbar.css" rel="stylesheet">
    <link href="${ASSET_CDN}/css/basic.css" rel="stylesheet">
<link href="//at.alicdn.com/t/c/font_4892763_skkvi1iofje.css" rel="stylesheet">
    <link rel="stylesheet" href="${ASSET_CDN}/d-proxy/style.css">
</head>
<body>
<div id="notification" class="notification"></div>
    <nav class="navbar navbar-expand-custom navbar-mainbg">
        <div class="navbar-content">
            <a class="navbar-brand navbar-logo" href="https://oproxy.cc/"><svg t="1745304037880" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5857" width="50" height="50"><path d="M339.793 1016.03c-46.16-15.87-98.994-44.87-142.51-78.225-18.053-13.838-51.386-45.977-70.906-68.367C68.884 803.493 28.653 715.93 11.08 618.492c-6.546-36.3-8.392-85.44-5.215-138.893 2.386-40.15 9.822-78.348 23.605-121.252 26.773-83.335 65.633-146.52 129.103-209.911 25.66-25.629 40.291-38.062 64.963-55.203C297.894 41.57 384.107 10.914 471.844 4.939c29.365-2 96.737 0.19 122.676 3.988 70.125 10.267 143.666 39.439 204.02 80.928 20.125 13.834 36.147 26.89 58.735 47.863 24.347 22.606 59.561 61.786 57.463 63.933-0.433 0.444-8.4-5.892-17.706-14.08-57.19-50.32-123.372-82.02-192.92-92.405-22.682-3.387-93.133-3.87-110.333-0.756-64.104 11.605-120.225 36.204-170.737 74.837-17.565 13.435-52.85 47.849-68.661 66.968l-7.416 8.968-19.137-8.499c-50.672-22.505-76.641-26.114-85.816-11.925-5.24 8.103-9.418 21.161-11.265 35.209-2.326 17.685-0.918 70.73 2.219 83.629 2.931 12.05 3.988 9.227-14.186 37.899-14.749 23.267-20.88 35.964-24.14 49.99-5.574 23.986-6.453 114.83-1.397 144.496 9.694 56.891 45.05 112.42 88.397 138.835 13.227 8.06 38.05 19.247 58.153 26.208 23.887 8.271 64.422 31.029 64.422 36.168 0 1.163-2.232 7.145-4.959 13.292-2.727 6.148-6.15 14.929-7.608 19.513-6.658 20.95-10.027 23.611-36.722 29.011-20.764 4.2-42.077 3.357-56.275-2.226-19.823-7.796-33.97-19.886-63.288-54.09-23.477-27.389-33.18-36.441-46.24-43.137-21.201-10.868-40.109-10.891-53.616-0.065-2.739 2.195-1.657 3.569 23.014 29.206 26.674 27.72 28.066 29.602 50.185 67.825 27.348 47.26 40.698 59.08 75.55 66.895 10.73 2.406 19.001 2.814 56.012 2.762l43.424-0.06-0.476 49.318c-0.513 53.188-0.613 53.891-9.052 63.336-4.589 5.136-13.525 4.423-34.371-2.744z" fill="currentColor" p-id="5858"></path><path d="M649.11 1017.688l-5.974-4.496-0.983-68.502c-0.54-37.676-0.983-82.782-0.983-100.235v-31.733l-8.145-15.54c-4.48-8.548-8.133-16.492-8.117-17.655 0.032-2.406 30.263-23.06 43.66-29.83 4.887-2.469 15.884-7.036 24.436-10.15 57.902-21.076 97.682-55.272 121.944-104.825 18.188-37.148 29.411-95.574 26.886-139.97-2.66-46.77-11.642-76.357-35.686-117.547-13.913-23.834-13.885-23.707-9.954-45.38 6.237-34.394 0.014-94.547-11.368-109.882-2.66-3.585-3.555-3.782-16.587-3.65-9.328 0.094-17.599 1.225-25.622 3.506-21.472 6.102-58.961 22.782-76.87 34.202-5.779 3.686-13.727 8.158-17.661 9.938-6.999 3.167-7.401 3.183-18.513 0.73-6.247-1.38-22.687-5.489-36.534-9.133-41.793-10.998-48.253-11.94-81.454-11.876-31.904 0.062-47.969 2.039-73.065 8.992-7.604 2.107-14.51 3.598-15.347 3.312-3.24-1.105 33.856-33.266 55.195-47.851 42.338-28.938 97.405-50.042 147.252-56.435 19.404-2.488 69.261-2.094 89.599 0.709 116.293 16.026 218.834 94.388 271.852 207.75 14.503 31.01 25.338 65.448 30.936 98.334 9.534 56 3.04 139.488-16.32 209.804-41.234 149.756-145.846 271.573-285.059 331.941-19.326 8.381-52.737 19.967-57.577 19.967-2.183 0-6.657-2.023-9.942-4.495z" fill="currentColor" p-id="5859"></path><path d="M338.558 624.084c-1.9-1.946-0.865-7.477 15.384-82.144 9.004-41.374 16.415-77.916 16.469-81.203 0.073-4.456-0.753-6.682-3.252-8.753-1.842-1.527-2.867-3.27-2.277-3.875 1.444-1.478 115.787-1.414 117.234 0.066 0.626 0.64-1.317 10.295-4.32 21.454-5.961 22.166-6.527 26.639-3.366 26.639 3.017 0 30.254-12.186 72.416-32.4l36.741-17.615 49.896 0.112c27.442 0.062 52.894 0.631 56.56 1.265l6.664 1.153-84.045 42.655c-65.889 33.44-84.046 43.263-84.046 45.467 0 3.203 8.645 8.377 74.049 44.314 50.372 27.678 71.28 39.866 71.595 41.736 0.135 0.807-24.03 1.547-58.083 1.778l-58.316 0.397-40.91-24.075c-44.217-26.022-58.053-33.554-61.637-33.554-2.807 0-3.616 2.124-11.451 30.045-3.414 12.167-7.4 23.343-8.859 24.835-2.434 2.492-6.44 2.713-49.054 2.713-25.523 0-46.849-0.454-47.392-1.01z" fill="currentColor" p-id="5860"></path></svg><span class="text">oproxy.cc</span></a>
            <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarSupportedContent" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Toggle navigation">
                <span class="iconfont">&#xe63c;</span>
            </button>
            <div class="collapse navbar-collapse" id="navbarSupportedContent">
                <ul class="navbar-nav ml-auto">
                    <div class="hori-selector">
                        <div class="left"></div>
                        <div class="right"></div>
                    </div>
                    <li class="nav-item">
                        <a class="nav-link" href="https://oproxy.cc/"><span class="iconfont">&#xe7ab;</span> Github 加速</a>
                    </li>
                    <li class="nav-item active">
                        <a class="nav-link" href="https://docker.oproxy.cc/"><span class="iconfont">&#xe6cc;</span> Docker 搜索</a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="https://kuwi.net/" target="_blank"><span class="iconfont">&#xe609;</span> KuWi</a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="https://www.afrp.net/" target="_blank"><span class="iconfont">&#xe608;</span> AFRP内网穿透</a>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container">
        <div class="search-container">
            <input type="text" id="search-input" placeholder="输入关键词搜索镜像，如: nginx, mysql, redis...">
            <button id="search-button" title="搜索"><span class="iconfont">&#xe63d;</span>
            </button>
        </div>
        <div class="tips">
            <p style="text-align: left;"><span class="iconfont">&#xe763;</span> 提示：输入要搜索镜像的关键词，按回车键快速搜索</p>
        </div>
        <div class="example">
            <div class="example-title"><span class="iconfont">&#xe655;</span>️️️ 基本使用示例：</div>
            <p><span class="iconfont">&#xe600;</span>️️️ 在官方镜像路径前面加上本站域名</p>            <pre><button class="copy-button" data-clipboard-target="#code1"><span class="copy-icon">&#xe60f;</span></button><code class="language-bash" id="code1">docker pull docker.oproxy.cc/snowdreamtech/frpc:latest</code></pre>            <pre><button class="copy-button" data-clipboard-target="#code2"><span class="copy-icon">&#xe60f;</span></button><code class="language-bash" id="code2">docker pull docker.oproxy.cc/library/nginx:stable-alpine3.19-perl</code></pre>
        </div>
        <div class="example">
            <div class="example-title"><span class="iconfont">&#xe617;</span>️️️ 一键设置镜像加速：</div>
            <p><span class="iconfont">&#xe600;</span>️️️ 修改文件 <span class="tag">/etc/docker/daemon.json</span>（如果不存在则创建）</p>            <pre><button class="copy-button" data-clipboard-target="#code3"><span class="copy-icon">&#xe60f;</span></button><code class="language-bash" id="code3">sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["docker.oproxy.cc"]
}
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker</code></pre>
        </div>
        <p style="position: sticky;top: calc(100% - 2.5em);">
            <br><br>
            Support by <a href="https://kuwi.net/" target="_blank"><span class="iconfont">&#xe609;</span> KuWi</a> ,  Run on <a href="https://workers.cloudflare.com/" target="_blank"><span class="iconfont">&#xebf2;</span> Cloudflare Workers</a> . Fonts made from <a href="http://www.onlinewebfonts.com" target="_blank">Web Fonts</a> is licensed by CC BY 4.0
        </p>
    </div>
    <!-- jQuery -->
    <script src="https://cdn.jsdelivr.net/npm/jquery@3.4.1/dist/jquery.min.js"></script>

    <!-- Popper.js -->
    <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.1/dist/umd/popper.min.js"></script>

    <!-- Bootstrap JS -->
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@4.5.2/dist/js/bootstrap.min.js"></script>

    <!-- Custom JS -->
    <script src="${ASSET_CDN}/js/navbar.js"></script>
    <script src="${ASSET_CDN}/d-proxy/script.js"></script>
</body>
</html>
`

/** DOCKER_AUTH 默认作用的主机（Docker Hub 的 token 端点） */
const DEFAULT_DOCKER_AUTH_HOSTS = ['auth.docker.io', 'auth.docker.com']

/** 额外允许的 token 端点（route 里的主机本身也会自动加入白名单） */
const BASE_AUTH_HOSTS = [
    'auth.docker.io',
    'ghcr.io',
    'quay.io',
    'gcr.io',
    'nvcr.io',
    'docker.cloudsmith.io',
    'registry.k8s.io',
    'k8s.gcr.io',
]

/** 逐跳头，转发时必须剔除 */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
])

/** 响应里必须剔除的头（content-length 要保留，客户端 HEAD 时要用） */
const RESPONSE_DROP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
])

/** 需要透传给上游的请求头 */
const PASSTHROUGH_HEADERS = [
    'authorization',
    'accept',
    'accept-language',
    'user-agent',
    'range',
    'if-none-match',
    'if-modified-since',
    'x-amz-content-sha256',
]

/** registry 路径前缀，命中即为镜像仓库请求 */
function isRegistryPath(pathname) {
    return pathname === '/v2' || pathname.startsWith('/v2/')
}

function splitList(value) {
    if (!value) return []
    return String(value)
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

/** 把 user:password 编成 Basic 认证头；已经是 base64 的直接用 */
function normalizeDockerAuth(value) {
    if (!value) return ''
    const raw = String(value).trim().replace(/^basic\s+/i, '')
    if (!raw.includes(':')) return 'Basic ' + raw
    try {
        return 'Basic ' + btoa(raw)
    } catch (err) {
        const bytes = new TextEncoder().encode(raw)
        let bin = ''
        for (const b of bytes) bin += String.fromCharCode(b)
        return 'Basic ' + btoa(bin)
    }
}

/** 读取环境变量配置（每次请求计算，不使用模块级可变状态） */
function loadConfig(env) {
    const routes = Object.assign({}, DEFAULT_ROUTES)
    if (env && env.ROUTES) {
        try {
            const custom = JSON.parse(env.ROUTES)
            if (custom && typeof custom === 'object') {
                for (const k of Object.keys(custom)) routes[String(k).toLowerCase()] = String(custom[k])
            }
        } catch (err) {
            console.warn('ROUTES 不是合法 JSON，已忽略:', err && err.message)
        }
    }
    const authHosts = new Set(BASE_AUTH_HOSTS)
    for (const host of Object.values(routes)) authHosts.add(String(host).toLowerCase())
    for (const host of splitList(env && env.AUTH_HOSTS)) authHosts.add(host.toLowerCase())

    return {
        routes,
        authHosts,
        blockedUA: ['netcraft'].concat(splitList(env && env.UA)).map((s) => s.toLowerCase()),
        homeUrl: (env && env.URL) || '',
        redirect302: (env && env.URL302) || '',
        homePageUrl: (env && env.HOME_PAGE_URL) || DEFAULT_HOME_PAGE_URL,
        // 内置首页开关：默认 1，设 0 回退到 HOME_PAGE_URL 反代
        builtinHome: String(env && env.BUILTIN_HOME !== undefined ? env.BUILTIN_HOME : '1') !== '0',
        cacheTtl: Number(env && env.CACHE_TTL) > 0 ? Number(env && env.CACHE_TTL) : 0,
        blobRedirect: String((env && env.BLOB_REDIRECT) || '') === '1',
        prefix: (env && env.PREFIX) || '',
        publicHost: (env && env.PUBLIC_HOST) || '',
        dockerAuth: normalizeDockerAuth(env && env.DOCKER_AUTH),
        dockerAuthHosts: new Set(DEFAULT_DOCKER_AUTH_HOSTS.concat(splitList(env && env.DOCKER_AUTH_HOSTS).map((s) => s.toLowerCase()))),
    }
}

/** 构造响应（统一附加 CORS） */
function makeRes(body, status = 200, headers = {}) {
    const h = new Headers(headers)
    h.set('access-control-allow-origin', '*')
    h.set('access-control-expose-headers', '*')
    h.set('x-content-type-options', 'nosniff')
    return new Response(body, { status, headers: h })
}

function jsonRes(data, status = 200, headers = {}) {
    return makeRes(JSON.stringify(data, null, 2), status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers))
}

/** 预检响应 */
function preflight() {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
            'access-control-allow-headers': '*',
            'access-control-expose-headers': '*',
            'access-control-max-age': '1728000',
        },
    })
}

/** 取本源站地址（用于把 realm 改写回本 Worker） */
function selfBase(url, cfg) {
    const publicHost = cfg && cfg.publicHost
    if (publicHost) {
        // 前面挂了 CDN / 反向代理时，realm 必须指向对外域名，否则客户端会去连源站域名
        return /^https?:\/\//i.test(publicHost) ? publicHost.replace(/\/$/, '') : 'https://' + publicHost
    }
    return url.protocol + '//' + url.host
}

/**
 * 把 Www-Authenticate 中的 realm 改写成本 Worker 的 /_token 端点。
 * docker 客户端会自行在后面追加 service / scope 参数。
 */
function rewriteWwwAuthenticate(value, base, prefix) {
    return value.replace(/realm="([^"]+)"/gi, (match, realm) => {
        let originPath = realm
        try {
            const u = new URL(realm)
            originPath = u.origin + u.pathname + u.search
        } catch (err) {
            // 非绝对地址，保持原样
            return match
        }
        return 'realm="' + base + prefix + '/_token?realm=' + encodeURIComponent(originPath) + '"'
    })
}

/** 只保留需要透传的请求头 */
function buildUpstreamHeaders(request, extra = {}) {
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
    }
    // 强制 identity：避免 CF 自动解压后 content-length 与实际字节数不一致，导致镜像层校验失败
    headers.set('accept-encoding', 'identity')
    const sha = request.headers.get('x-amz-content-sha256')
    if (sha) headers.set('x-amz-content-sha256', sha)
    for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === undefined) headers.delete(k)
        else headers.set(k, v)
    }
    return headers
}

/** Docker Hub 对无命名空间的官方镜像要求 /v2/library/{name}/... */
function normalizeDockerHubPath(pathname) {
    const m = /^\/v2\/([^/]+)\/(manifests|blobs|tags|referrers)\/(.+)$/.exec(pathname)
    if (!m) return pathname
    const repo = m[1]
    if (repo === 'library') return pathname
    return '/v2/library/' + repo + '/' + m[2] + '/' + m[3]
}

/** 判断请求是否匿名：无 Authorization，或 Bearer token 的 sub 为空（Docker Hub 匿名 token 就是这样）。
 *  带账号的 token 一律不缓存，避免私有镜像被别的请求命中缓存。 */
function isAnonymousRequest(request) {
    const auth = request.headers.get('authorization')
    if (!auth) return true
    const m = /^bearer\s+(.+)$/i.exec(auth.trim())
    if (!m) return false
    const parts = m[1].split('.')
    if (parts.length < 2) return false
    try {
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
        const json = JSON.parse(atob(padded))
        return !json || String(json.sub || '') === ''
    } catch (err) {
        return false
    }
}

/** 边缘缓存 key：去掉 hubhost / ns 参数，避免同一资源被拆成多份缓存 */
function cacheKeyUrl(url) {
    const u = new URL(url.href)
    u.searchParams.delete('hubhost')
    u.searchParams.delete('ns')
    u.hash = ''
    return u.href
}

/** 根据路径判断资源类型，用于缓存策略 */
function resourceKind(pathname) {
    if (/\/manifests\//.test(pathname)) return 'manifest'
    if (/\/blobs\//.test(pathname)) return 'blob'
    return 'meta'
}

/**
 * 内部跟随重定向：跟主机时丢弃 Authorization（避免把 token 泄漏给 CDN）。
 * 最多 5 跳。
 */
async function fetchFollow(target, init, options = {}) {
    const followRedirect = options.follow !== false
    let current = target
    let headers = init.headers
    let response = null
    for (let hop = 0; hop < 5; hop++) {
        response = await fetch(new Request(current.href, {
            method: init.method,
            headers,
            // GET/HEAD 无 body；其他方法把原始 body 流透传
            body: init.body,
            redirect: 'manual',
        }))
        if (!followRedirect) return response
        const location = response.headers.get('location')
        if (!location || response.status < 300 || response.status > 399) return response
        const next = new URL(location, current.href)
        if (next.protocol !== 'https:') return response
        if (next.hostname.toLowerCase() !== current.hostname.toLowerCase()) {
            const h = new Headers(headers)
            h.delete('authorization')
            headers = h
        }
        current = next
    }
    return response
}

/** 选上游仓库主机 */
function resolveUpstream(url, cfg) {
    const override = url.searchParams.get('hubhost') || url.searchParams.get('ns')
    if (override) {
        const host = override.trim().toLowerCase()
        if (host === 'docker.io' || host === 'hub.docker.com') return DEFAULT_REGISTRY
        if (!/^[a-z0-9][a-z0-9.-]*(:\d+)?$/.test(host)) return null
        return host
    }
    const hostTop = url.hostname.split('.')[0].toLowerCase()
    if (cfg.routes[hostTop]) return cfg.routes[hostTop]
    return cfg.routes.default || DEFAULT_REGISTRY
}

/** 代理 registry 请求 */
async function handleRegistry(request, url, cfg, ctx) {
    const upstreamHost = resolveUpstream(url, cfg)
    if (!upstreamHost) {
        return jsonRes({ errors: [{ code: 'BAD_REQUEST', message: '非法的 hubhost / ns 参数' }] }, 400)
    }

    const target = new URL(url.href)
    target.protocol = 'https:'
    const colon = upstreamHost.indexOf(':')
    target.hostname = colon > 0 ? upstreamHost.slice(0, colon) : upstreamHost
    target.port = colon > 0 ? upstreamHost.slice(colon + 1) : ''
    target.hash = ''
    target.searchParams.delete('hubhost')
    target.searchParams.delete('ns')
    if (upstreamHost === DEFAULT_REGISTRY) {
        target.pathname = normalizeDockerHubPath(target.pathname)
    }

    // 匿名 GET 的 manifest / blob 走边缘缓存：既省回源流量，也少消耗上游拉取额度
    const kind = resourceKind(target.pathname)
    const canCache = cfg.cacheTtl > 0 && request.method === 'GET'
        && (kind === 'manifest' || kind === 'blob')
        && isAnonymousRequest(request)
        && typeof caches !== 'undefined' && caches.default
    let cacheKey = null
    if (canCache) {
        cacheKey = new Request(cacheKeyUrl(url), { method: 'GET' })
        const hit = await caches.default.match(cacheKey)
        if (hit) {
            const cachedHeaders = new Headers(hit.headers)
            cachedHeaders.set('x-proxy-cache', 'HIT')
            return new Response(hit.body, { status: hit.status, headers: cachedHeaders })
        }
    }

    const init = {
        method: request.method,
        headers: buildUpstreamHeaders(request),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        // BLOB_REDIRECT 模式下不跟随，直接把上游 307 交给客户端
        follow: !(cfg.blobRedirect && resourceKind(target.pathname) === 'blob'),
    }

    const upstreamRes = await fetchFollow(target, init, { follow: init.follow })

    if (upstreamRes.status === 401) {
        const challenge = upstreamRes.headers.get('www-authenticate')
        if (challenge) {
            const headers = new Headers(upstreamRes.headers)
            headers.set('www-authenticate', rewriteWwwAuthenticate(challenge, selfBase(url, cfg), cfg.prefix))
            return finalize(upstreamRes, headers, url, cfg, target.pathname)
        }
    }

    // blob 重定向：可选直接回给客户端
    if (init.follow === false && resourceKind(target.pathname) === 'blob') {
        const location = upstreamRes.headers.get('location')
        if (location && upstreamRes.status >= 300 && upstreamRes.status <= 399) {
            return new Response(null, {
                status: 307,
                headers: {
                    location,
                    'access-control-allow-origin': '*',
                    'access-control-expose-headers': '*',
                },
            })
        }
    }

    const response = finalize(upstreamRes, upstreamRes.headers, url, cfg, target.pathname)
    if (cacheKey && response.status === 200 && ctx && ctx.waitUntil) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()))
    }
    return response
}

/** 组装最终响应：清理逐跳头、补 CORS / 缓存，流式返回 */
function finalize(upstreamRes, rawHeaders, url, cfg, pathname) {
    const headers = new Headers()
    for (const [k, v] of rawHeaders) {
        if (RESPONSE_DROP.has(k.toLowerCase())) continue
        headers.set(k, v)
    }
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-expose-headers', '*')
    headers.delete('content-security-policy')
    headers.delete('content-security-policy-report-only')
    headers.delete('clear-site-data')
    headers.delete('set-cookie')

    const kind = resourceKind(pathname)
    if (cfg.cacheTtl > 0 && !headers.has('cache-control')) {
        headers.set('cache-control', 'public, max-age=' + cfg.cacheTtl)
    } else if (kind === 'blob' && !headers.has('cache-control')) {
        // blob 内容按 digest 索引，天然不可变
        headers.set('cache-control', 'public, max-age=31536000, immutable')
    }

    const body = upstreamRes.body
    return new Response(body, { status: upstreamRes.status, headers })
}

/** 转发认证令牌请求（/_token?realm=... 或兼容旧路径 /token） */
async function handleToken(request, url, cfg) {
    const realm = url.searchParams.get('realm')
    let target
    if (realm) {
        if (!/^https:\/\//i.test(realm)) {
            return jsonRes({ errors: [{ code: 'BAD_REQUEST', message: 'realm 必须是 https 绝对地址' }] }, 400)
        }
        try {
            target = new URL(realm)
        } catch (err) {
            return jsonRes({ errors: [{ code: 'BAD_REQUEST', message: 'realm 解析失败' }] }, 400)
        }
    } else {
        // 兼容只带路径的旧调用
        target = new URL('https://auth.docker.io' + url.pathname)
    }

    if (!cfg.authHosts.has(target.hostname.toLowerCase())) {
        return jsonRes({ errors: [{ code: 'FORBIDDEN', message: 'token 端点不在白名单: ' + target.hostname }] }, 403)
    }

    const params = new URLSearchParams(url.searchParams)
    params.delete('realm')
    params.delete('hubhost')
    params.delete('ns')
    target.search = params.toString()

    const upstreamHeaders = buildUpstreamHeaders(request)
    // 匿名客户端 + 配了 DOCKER_AUTH：用 Worker 自己的账号换 token，规避 Docker Hub 匿名 IP 限流
    if (cfg.dockerAuth && !upstreamHeaders.has('authorization') && cfg.dockerAuthHosts.has(target.hostname.toLowerCase())) {
        upstreamHeaders.set('authorization', cfg.dockerAuth)
    }

    const res = await fetchFollow(target, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    }, { follow: true })

    const headers = new Headers()
    for (const [k, v] of res.headers) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue
        headers.set(k, v)
    }
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-expose-headers', '*')
    headers.delete('set-cookie')
    return new Response(res.body, { status: res.status, headers })
}

/** 伪装页 */
function nginxPage() {
    return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>body{width:35em;margin:0 auto;font-family:Tahoma,Verdana,Arial,sans-serif}</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`
}

/** 首页：镜像搜索页 / 伪装页 / 302 跳转 */
async function handleLanding(request, url, cfg) {
    if (url.pathname !== '/' && url.pathname !== '') {
        return makeRes('Not Found', 404, { 'content-type': 'text/plain; charset=utf-8' })
    }
    if (cfg.redirect302) return Response.redirect(cfg.redirect302, 302)
    if (cfg.homeUrl) {
        if (cfg.homeUrl.toLowerCase() === 'nginx') {
            return makeRes(nginxPage(), 200, { 'content-type': 'text/html; charset=UTF-8' })
        }
        try {
            const forwarded = await fetch(cfg.homeUrl, { headers: { 'user-agent': request.headers.get('user-agent') || 'cf-dockerhub' } })
            const headers = new Headers(forwarded.headers)
            headers.delete('content-security-policy')
            headers.delete('content-security-policy-report-only')
            headers.delete('set-cookie')
            headers.set('access-control-allow-origin', '*')
            return new Response(forwarded.body, { status: forwarded.status, headers })
        } catch (err) {
            return makeRes(nginxPage(), 502, { 'content-type': 'text/html; charset=UTF-8' })
        }
    }
    // 首页直接返回内置 HTML：不再从 github.io 反代，源站断网首页也不会崩
    if (cfg.builtinHome) {
        return makeRes(HOME_HTML, 200, { 'content-type': 'text/html; charset=UTF-8', 'cache-control': 'no-cache' })
    }
    try {
        const upstream = await fetch(cfg.homePageUrl, {
            headers: { 'user-agent': request.headers.get('user-agent') || 'cf-dockerhub' },
            // 首页允许缓存 10 分钟，减少对源站的压力
            cf: { cacheTtl: 600, cacheEverything: true },
        })
        if (!upstream.ok) throw new Error('upstream ' + upstream.status)
        return makeRes(await upstream.text(), 200, { 'content-type': 'text/html; charset=UTF-8', 'cache-control': 'public, max-age=600' })
    } catch (err) {
        return makeRes(nginxPage(), 200, { 'content-type': 'text/html; charset=UTF-8' })
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        const method = request.method
        const cfg = loadConfig(env || {})

        // 预检
        if (method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
            return preflight()
        }

        // 路由前缀
        let pathname = url.pathname
        if (cfg.prefix && pathname.startsWith(cfg.prefix)) {
            pathname = pathname.slice(cfg.prefix.length) || '/'
            url.pathname = pathname
        }

        // 健康检查
        if (pathname === '/_health' || pathname === '/healthz') {
            return jsonRes({
                status: 'ok',
                version: VERSION,
                upstream: resolveUpstream(url, cfg),
                base: selfBase(url, cfg),
                builtinHome: cfg.builtinHome,
                assetCommit: ASSET_COMMIT,
                time: new Date().toISOString(),
            })
        }

        // token 端点
        if (pathname === '/_token' || pathname === '/token' || pathname.endsWith('/token')) {
            return handleToken(request, url, cfg)
        }

        // 爬虫屏蔽（所有路径统一返回伪装页）
        const ua = (request.headers.get('user-agent') || '').toLowerCase()
        if (cfg.blockedUA.length && cfg.blockedUA.some((k) => k && ua.includes(k))) {
            return makeRes(nginxPage(), 200, { 'content-type': 'text/html; charset=UTF-8' })
        }

        // 兼容旧版 docker search 接口（hub.docker.com Web API，路径是 /v1/...）
        if (/^\/v1\/(search|repositories)/.test(pathname) && !url.searchParams.get('hubhost')) {
            const target = new URL(url.href)
            target.protocol = 'https:'
            target.hostname = 'hub.docker.com'
            target.port = ''
            const res = await fetch(target.href, { method, headers: buildUpstreamHeaders(request), redirect: 'manual' })
            return finalize(res, res.headers, url, cfg, pathname)
        }

        // registry 请求
        if (isRegistryPath(pathname)) {
            try {
                return await handleRegistry(request, url, cfg, ctx)
            } catch (err) {
                console.error('registry 代理失败:', err && err.stack)
                return jsonRes({ errors: [{ code: 'UNKNOWN', message: '上游请求失败: ' + (err && err.message) }] }, 502)
            }
        }

        return handleLanding(request, url, cfg)
    },
}
