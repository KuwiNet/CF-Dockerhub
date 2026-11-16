/**
 * CF-Dockerhub — Docker / OCI 镜像仓库反向代理（Cloudflare Workers）
 *
 * 相比 v1（原 docker-proxy 模板）的主要改动：
 *   1. 认证令牌端点不再硬编码 auth.docker.io：401 响应里的 realm 会被改写到本 Worker 的
 *      /_token?realm=... ，因此 ghcr / gcr / quay / nvcr / k8s 等仓库的 token 也能正确转发。
 *   2. 去掉脆弱的 %3A / %2F 字符串替换：不再改写 query，也不会把 sha256 摘要改坏。
 *   3. registry 路径不再受 User-Agent 影响（浏览器访问 /v2/... 同样按 registry 处理）。
 *   4. 重定向（blob 307 到 CDN）在 Worker 内部跟随，且跨主机时自动丢弃 Authorization；
 *      可选 BLOB_REDIRECT=1 直接把 307 返回给客户端。
 *   5. 上游主机、屏蔽 UA、首页行为全部走环境变量，不再依赖模块级可变状态（避免并发串号）。
 *   6. 增加 /_health 健康检查、OPTIONS 预检、CORS 头、缓存策略与结构化错误。
 *
 * 环境变量（Cloudflare Workers → Settings → Variables）：
 *   ROUTES         JSON，覆盖/扩展子域名到上游仓库的映射，例如 {"myreg":"registry.example.com"}
 *   UA             追加要屏蔽的爬虫 UA，逗号分隔
 *   URL            首页行为："nginx" 返回伪装页；其他值则反代该地址
 *   URL302         首页 302 跳转地址（优先级高于 URL）
 *   HOME_PAGE_URL  首页要展示的镜像搜索页地址（默认 kuwinet.github.io/d-proxy）
 *   CACHE_TTL      manifest/blob 的 Cache-Control max-age（秒），默认沿用上游
 *   BLOB_REDIRECT  设为 1 时，blob 重定向原样返回 307 给客户端（不经过 Worker 流量）
 *   AUTH_HOSTS     追加允许作为 token 端点的主机，逗号分隔
 *   PREFIX         路由前缀，默认空；例如挂在 example.com/docker/* 时设为 /docker
 */

const VERSION = '2.1.0'

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
		cacheTtl: Number(env && env.CACHE_TTL) > 0 ? Number(env.CACHE_TTL) : 0,
		blobRedirect: String((env && env.BLOB_REDIRECT) || '') === '1',
		prefix: (env && env.PREFIX) || '',
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
function selfBase(url) {
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

/** 根据路径判断资源类型，用于缓存策略 */
function resourceKind(pathname) {
	if (/\/manifests\//.test(pathname)) return 'manifest'
	if (/\/blobs\//.test(pathname)) return 'blob'
	return 'meta'
}

/**
 * 内部跟随重定向：跨主机时丢弃 Authorization（避免把 token 泄漏给 CDN）。
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
async function handleRegistry(request, url, cfg) {
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
			headers.set('www-authenticate', rewriteWwwAuthenticate(challenge, selfBase(url), cfg.prefix))
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

	return finalize(upstreamRes, upstreamRes.headers, url, cfg, target.pathname)
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

	const res = await fetchFollow(target, {
		method: request.method,
		headers: buildUpstreamHeaders(request),
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
				return await handleRegistry(request, url, cfg)
			} catch (err) {
				console.error('registry 代理失败:', err && err.stack)
				return jsonRes({ errors: [{ code: 'UNKNOWN', message: '上游请求失败: ' + (err && err.message) }] }, 502)
			}
		}

		return handleLanding(request, url, cfg)
	},
}
