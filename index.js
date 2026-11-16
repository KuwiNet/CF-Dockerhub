/**
 * CF-Dockerhub 部署入口（2026-11-16）
 *
 * 为什么多一层入口：worker.js 的 registry 代理逻辑不动，只在这里额外接住
 *   /search        —— 首页搜索框跳转的路径（原来会掉进 handleLanding 直接 404）
 *   /search/_debug —— 搜索链路诊断（返回每个上游的 status/耗时/片段）
 *   /v1/search     —— 老版 docker search 客户端用的路径（上游 registry 早已下线，必 404）
 *
 * 上游说明：registry 的 /v1/search 已下线，能用的只有 hub.docker.com 的 Web API。
 * 现实问题是 Cloudflare 出口 IP 被 hub.docker.com 限流（Worker 里固定 429），
 * 所以这里做了三件事：换浏览器 UA → 多上游依次兜底 → 边缘缓存缓存住成功结果；
 * 即使全部失败，页面依然给出“按名字直接拉取”的可用命令（搜索只是锦上添花）。
 *
 * wrangler.toml 的 main 指向本文件；其余请求原样交给 worker.js。
 */

import worker from './worker.js'
import mirrors from './mirrors.js'

const SEARCH_PAGE_SIZE = 25
const SEARCH_CACHE_TTL = 600
// 单个上游最多等 4 秒：上游挂住时也不能让页面一直转圈（Workers 本身没有请求超时）
const SEARCH_TRY_TIMEOUT = 4000
const SEARCH_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 上游候选：按顺序尝试，前一个失败（429/5xx）就换下一个 */
const UPSTREAMS = [
	{
		name: 'v2',
		url: (q, page) =>
			'https://hub.docker.com/v2/search/repositories/?query=' +
			encodeURIComponent(q) +
			'&page=' + page + '&page_size=' + SEARCH_PAGE_SIZE,
		json: true,
		parse: (d) => ({
			total: Number(d.count || 0),
			items: (d.results || []).map((r) => ({
				repo: r.repo_name || '',
				desc: r.short_description || '',
				stars: r.star_count,
				pulls: r.pull_count,
				official: !!r.is_official,
			})),
		}),
	},
	{
		name: 'v4',
		url: (q, page) =>
			'https://hub.docker.com/api/search/v4/query?query=' +
			encodeURIComponent(q) +
			'&size=' + SEARCH_PAGE_SIZE + '&page=' + page,
		json: true,
		parse: (d) => ({
			total: Number(d.total || 0),
			items: (d.results || []).map((r) => ({
				repo: r.name || r.slug || '',
				desc: r.short_description || '',
				stars: r.star_count,
				pulls: r.pull_count,
				official: !!r.is_official,
			})),
		}),
	},
	{
		name: 'jina',
		url: (q, page) =>
			'https://r.jina.ai/https://hub.docker.com/v2/search/repositories/?query=' +
			encodeURIComponent(q) +
			'&page=' + page + '&page_size=' + SEARCH_PAGE_SIZE,
		json: false,
		parse: (text) => {
			const raw = text.slice(text.indexOf('Markdown Content:') + 17).trim()
			return UPSTREAMS[0].parse(JSON.parse(raw))
		},
	},
]

/** 对外域名：优先 PUBLIC_HOST（前置 CDN 时用），否则用当前请求的 origin */
function baseOf(url, env) {
	const raw = env && env.PUBLIC_HOST ? String(env.PUBLIC_HOST).trim() : ''
	if (raw) return 'https://' + raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
	return url.origin
}

/** 去掉可能存在的 PREFIX，得到真实路径 */
function routePath(pathname, env) {
	const prefix = env && env.PREFIX ? String(env.PREFIX).trim() : ''
	if (!prefix) return pathname
	if (pathname === prefix) return '/'
	if (pathname.startsWith(prefix + '/')) return pathname.slice(prefix.length)
	return pathname
}

function esc(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function headers() {
	return {
		'user-agent': SEARCH_UA,
		accept: 'application/json',
		'referer': 'https://hub.docker.com/search',
		'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
	}
}

/** 并发尝试上游（谁先成功用谁），返回 { data, from, attempts }；全失败也总共只等一个超时 */
async function querySearch(q, page) {
	const jobs = UPSTREAMS.map(async (up) => {
		const started = Date.now()
		const url = up.url(q, page)
		try {
			const res = await fetch(url, {
				headers: headers(),
				signal: AbortSignal.timeout(SEARCH_TRY_TIMEOUT),
				cf: { cacheTtl: 300, cacheEverything: true },
			})
			const text = await res.text()
			const rec = { name: up.name, status: res.status, ms: Date.now() - started, head: text.slice(0, 120) }
			if (!res.ok) return { up, rec }
			const data = up.json ? up.parse(JSON.parse(text)) : up.parse(text)
			if (!data || !data.items) return { up, rec }
			return { up, rec, data }
		} catch (err) {
			return { up, rec: { name: up.name, status: 0, ms: Date.now() - started, error: (err && err.message) || 'unknown' } }
		}
	})
	const results = await Promise.all(jobs)
	const attempts = results.map((r) => r.rec)
	for (const up of UPSTREAMS) {
		const hit = results.find((r) => r.up === up && r.data)
		if (hit) return { data: hit.data, from: up.name, attempts }
	}
	return { data: null, from: '', attempts }
}

/**
 * 内置镜像索引（mirrors.js，141 个 Docker 官方镜像，离线数据）
 * 每行：[名称, 是否官方, star 数, 拉取数, 描述]
 *
 * 为什么需要它：hub.docker.com 的 Web 搜索接口对 Cloudflare 出口 IP 长期 429，
 * 只靠上游实时搜索等于"永远没结果"。本地索引保证常见镜像一定能搜到，
 * 上游能通时仍然优先用上游（结果更新、覆盖非官方镜像）。
 */
const LOCAL_INDEX = Array.isArray(mirrors) ? mirrors : []

function localSearch(q, limit) {
	const needle = String(q || '').trim().toLowerCase()
	if (!needle) return []
	const out = []
	for (const row of LOCAL_INDEX) {
		const name = row[0] || ''
		if (!name) continue
		const lower = name.toLowerCase()
		let score = 0
		if (lower === needle) score = 100
		else if (lower.startsWith(needle)) score = 80
		else if (lower.includes(needle)) score = 60
		else if (String(row[4] || '').toLowerCase().includes(needle)) score = 20
		if (!score) continue
		out.push({
			repo: name,
			official: !!row[1],
			stars: row[2] || null,
			pulls: row[3] || null,
			desc: row[4] || '',
			score,
		})
	}
	out.sort((a, b) => b.score - a.score || (b.pulls || 0) - (a.pulls || 0) || a.repo.length - b.repo.length)
	return out.slice(0, limit || 40).map(({ score, ...rest }) => rest)
}

/** 把 DOCKER_AUTH 编成 Basic 头（与 worker.js 的 normalizeDockerAuth 保持一致） */
function basicAuth(env) {
	const raw = String((env && env.DOCKER_AUTH) || '').trim().replace(/^basic\s+/i, '')
	if (!raw) return ''
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

/**
 * 用 registry 校验镜像是否存在——知道完整名字时最可靠的"搜索"。
 * 走 registry.docker.io + DOCKER_AUTH 的账号额度，不受 hub.docker.com 的 Web 搜索限流影响。
 * 单段名字先当官方镜像（library/x）试，再当"同名命名空间"（x/x）试。
 */
async function probeOne(repo, auth) {
	try {
		const tokenUrl =
			'https://auth.docker.io/token?service=registry.docker.io&scope=repository:' +
			encodeURIComponent(repo) + ':pull'
		const tokenRes = await fetch(tokenUrl, {
			headers: auth ? { authorization: auth } : {},
			signal: AbortSignal.timeout(2500),
		})
		if (!tokenRes.ok) return { kind: 'error' }
		const token = (await tokenRes.json()).token
		if (!token) return { kind: 'error' }
		const res = await fetch('https://registry-1.docker.io/v2/' + repo + '/manifests/latest', {
			headers: {
				authorization: 'Bearer ' + token,
				accept:
					'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, ' +
					'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
			},
			signal: AbortSignal.timeout(5000),
		})
		if (res.status === 404 || res.status === 401) return { kind: 'notfound' }
		if (res.status !== 200) return { kind: 'error' }
		return {
			kind: 'ok',
			repo,
			digest: res.headers.get('docker-content-digest') || '',
			official: repo.startsWith('library/'),
		}
	} catch (err) {
		return { kind: 'error' }
	}
}

async function registryProbe(q, env) {
	const raw = String(q || '').trim().replace(/^\/+/, '')
	if (!raw || raw.length > 120) return null
	const auth = basicAuth(env)
	if (raw.includes('/')) {
		const hit = await probeOne(raw, auth)
		return hit.kind === 'ok' ? hit : null
	}
	const started = Date.now()
	const first = await probeOne('library/' + raw, auth)
	if (first.kind === 'ok') return first
	// 官方库里没有（401/404），再当"同名命名空间"试一次；超过预算就直接放弃
	const spent = Date.now() - started
	if (spent > 6000) return null
	const second = await probeOne(raw + '/' + raw, auth)
	return second.kind === 'ok' ? second : null
}

function pullCard(q, base) {
	if (!q) return ''
	const name = base.replace(/^https?:\/\//, '')
	const pull = 'docker pull ' + name + '/' + q
	return (
		'<div class="card direct"><div class="head"><span class="name">直接拉取「' + esc(q) + '」</span>' +
		'<span class="badge">按名字拉</span></div>' +
		'<div class="cmd"><code>' + esc(pull) + '</code><button class="copy" data-cmd="' + esc(pull) + '">复制</button></div>' +
		'<p class="desc" style="margin:10px 0 0">搜索接口被 Docker Hub 限流时也能用：把镜像名（含命名空间，如 <code>afrp/afrp</code>）填进地址即可。</p></div>'
	)
}

function resultRows(items, base) {
	if (!items.length) return '<p class="empty">没有匹配的镜像，换个关键词试试。</p>'
	return items
		.map((r) => {
			const repo = r.repo || ''
			const official = r.official || /^library\//.test(repo)
			const desc = r.desc || (official ? 'Docker 官方镜像' : '（无描述）')
			const pull = 'docker pull ' + base.replace(/^https?:\/\//, '') + '/' + repo
			const badge = official ? '<span class="badge">官方</span>' : ''
			const stars = r.stars == null ? '' : '<span class="meta">★ ' + esc(r.stars) + '</span>'
			const pulls = r.pulls == null ? '' : '<span class="meta">↓ ' + esc(r.pulls) + '</span>'
			return (
				'<div class="card"><div class="head"><span class="name">' + esc(repo) + '</span>' + badge + stars + pulls +
				'</div><p class="desc">' + esc(desc) + '</p><div class="cmd"><code>' + esc(pull) +
				'</code><button class="copy" data-cmd="' + esc(pull) + '">复制</button></div></div>'
			)
		})
		.join('')
}

function searchPage({ q, page, total, items, base, error, source }) {
	const pages = Math.max(1, Math.ceil((total || 0) / SEARCH_PAGE_SIZE))
	const prev = page > 1 ? '<a href="/search?q=' + encodeURIComponent(q) + '&page=' + (page - 1) + '">← 上一页</a>' : '<span></span>'
	const next = page < pages ? '<a href="/search?q=' + encodeURIComponent(q) + '&page=' + (page + 1) + '">下一页 →</a>' : '<span></span>'
	let summary
	if (error) {
		summary =
			'<p class="empty">Docker Hub 的搜索接口当前限流（' + esc(error) + '），可以先按上面那条命令直接拉取；' +
			'如果知道完整镜像名（如 <code>afrp/afrp</code>），把它填进搜索框，站点会直接去 registry 校验它是否存在。' +
			'也可以打开 <a class="outlink" href="https://hub.docker.com/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noreferrer">Docker Hub 官方搜索</a>。</p>'
	} else if (source === 'local') {
		summary =
			'<p class="empty" style="margin-bottom:14px">以下结果来自<b>内置镜像索引</b>（' + LOCAL_INDEX.length + ' 个 Docker 官方镜像，离线数据）。' +
			'Docker Hub 的实时搜索接口当前对本站出口 IP 限流，所以没有联网结果；要搜非官方镜像，请在地址里填完整名字，例如 <code>/search?q=afrp/afrp</code>，站点会直接去 registry 校验。' +
			'<a class="outlink" href="https://hub.docker.com/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noreferrer">到 Docker Hub 搜</a></p>'
	} else if (source === 'registry') {
		summary =
			'<p class="empty" style="margin-bottom:14px">实时搜索被限流，已改用 <b>registry 校验</b>：这个镜像确实存在（走本站的账号额度，不受 Web 搜索限流影响）。</p>'
	} else {
		summary = '<p class="summary">共 ' + esc(total) + ' 个结果 · 第 ' + esc(page) + ' / ' + esc(pages) + ' 页</p>'
	}
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(q)} - Docker 镜像搜索</title>
<link rel="shortcut icon" href="https://kuwinet.github.io/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,#8100c2 0%,#46006a 100%);color:#f0f6fc;font-family:"Comfortaa Bold",-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px 20px 60px}
.wrap{max-width:900px;margin:0 auto}
.back{display:inline-block;color:rgba(255,255,255,.75);text-decoration:none;font-size:14px;margin-bottom:14px}
.back:hover{color:#fff}
h1{font-size:22px;margin-bottom:16px}
form{position:relative;margin:0 auto 18px;max-width:860px}
input{width:100%;height:56px;padding:0 60px 0 24px;border:2px solid transparent;border-radius:12px;font-size:15px;color:#1f2937;background:rgba(255,255,255,.9);box-shadow:0 4px 12px rgba(0,0,0,.15);transition:all .3s ease}
input:focus{outline:none;border-color:#6e00aa;background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.6)}
.sbtn{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:44px;height:44px;padding:0;border:none;border-radius:8px;background:#6e00aa;color:#fff;cursor:pointer;display:flex;justify-content:center;align-items:center;transition:all .2s ease}
.sbtn:hover{background:#9f00f4;transform:translateY(-50%) scale(1.05)}
.summary{color:rgba(255,255,255,.7);font-size:14px;margin-bottom:14px}
.empty{color:rgba(255,255,255,.85);padding:16px 18px;background:rgba(255,255,255,.06);border-radius:12px;line-height:1.7;font-size:14px}
.empty code{background:rgba(0,0,0,.25);padding:2px 6px;border-radius:6px;font-size:13px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px 18px;margin-bottom:12px}
.direct{border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.09);margin-bottom:18px}
.outlink{color:#ffd98a}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.name{color:#fff;font-size:16px;font-weight:700;word-break:break-all}
.badge{font-size:12px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.18)}
.meta{font-size:12px;color:rgba(255,255,255,.65)}
.desc{color:rgba(255,255,255,.8);font-size:14px;line-height:1.5;margin-bottom:10px;word-break:break-word}
.desc code{background:rgba(0,0,0,.25);padding:1px 5px;border-radius:5px;font-size:13px}
.cmd{display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.22);border-radius:8px;padding:10px 12px}
.cmd code{flex:1;font-size:13px;color:#e7d7ff;word-break:break-all}
.copy{border:none;border-radius:6px;background:rgba(255,255,255,.16);color:#fff;font-size:12px;padding:6px 10px;cursor:pointer}
.copy:hover{background:rgba(255,255,255,.3)}
.pager{display:flex;justify-content:space-between;margin-top:18px;font-size:14px}
.pager a{color:#fff;text-decoration:none;border-bottom:1px dashed rgba(255,255,255,.5)}
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="/">← 返回镜像加速首页</a>
<h1>Docker 镜像搜索</h1>
<form action="/search" method="get"><input type="text" name="q" value="${esc(q)}" placeholder="搜索镜像，如 nginx、mysql、redis" autofocus><button class="sbtn" type="submit" aria-label="搜索"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 21 21"></path></svg></button></form>
${pullCard(q, base)}
${summary}
${error ? '' : resultRows(items, base)}
<div class="pager">${prev}${next}</div>
</div>
<script>
document.querySelectorAll('.copy').forEach(function (btn) {
	btn.addEventListener('click', function () {
		var text = btn.getAttribute('data-cmd') || ''
		var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制' }, 1500) }
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done)
		else done()
	})
})
</script>
</body>
</html>`
}

/** 边缘缓存：成功结果缓存 10 分钟，缓解上游限流 */
async function readCache(q, page) {
	try {
		const hit = await caches.default.match(cacheUrl(q, page))
		if (!hit) return null
		return await hit.json()
	} catch (err) {
		return null
	}
}

function cacheUrl(q, page) {
	return new Request('https://search-cache.internal/v1?q=' + encodeURIComponent(q) + '&p=' + page)
}

async function writeCache(q, page, payload, ctx) {
	try {
		const res = new Response(JSON.stringify(payload), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + SEARCH_CACHE_TTL },
		})
		const put = caches.default.put(cacheUrl(q, page), res)
		if (ctx && ctx.waitUntil) ctx.waitUntil(put)
		else await put
	} catch (err) {
		/* 缓存失败不影响结果 */
	}
}

async function handleSearch(request, url, env, ctx, path) {
	const q = (url.searchParams.get('q') || '').trim()
	const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1)
	const base = baseOf(url, env)
	const wantsJson = path === '/v1/search' || (request.headers.get('accept') || '').includes('application/json')

	// 诊断端点
	if (path === '/search/_debug') {
		const local = localSearch(q || 'nginx', 5)
		const r = await querySearch(q || 'nginx', page)
		return new Response(
			JSON.stringify({
				q,
				page,
				localIndex: LOCAL_INDEX.length,
				localHits: local.map((x) => x.repo),
				from: r.from,
				attempts: r.attempts,
			}, null, 2),
			{
				status: r.data ? 200 : 502,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			}
		)
	}

	let payload = q ? await readCache(q, page) : null
	const fromCache = !!payload
	let error = ''
	if (!payload && q) {
		// 1) 先查本地索引：命中就不必等上游超时，常见镜像立刻出结果
		const local = localSearch(q, SEARCH_PAGE_SIZE)
		if (local.length) {
			payload = { total: local.length, items: local, from: 'local' }
		} else {
			// 2) 本地没有 → 先问 registry：一次目录级校验比等上游快得多，也不受 Web 搜索限流影响
			const probe = await registryProbe(q, env)
			if (probe) {
				payload = {
					total: 1,
					items: [{
						repo: probe.repo,
						desc: probe.digest ? 'registry 校验通过 · latest digest ' + probe.digest : 'registry 校验通过',
						stars: null,
						pulls: null,
						official: probe.official,
					}],
					from: 'registry',
				}
			} else {
				// 3) registry 里也没这个名字 → 再试实时上游（并发，最坏只等一个超时）
				const r = await querySearch(q, page)
				if (r.data) {
					payload = { total: r.data.total, items: r.data.items, from: r.from, at: new Date().toISOString() }
					await writeCache(q, page, payload, ctx)
				} else {
					const last = r.attempts[r.attempts.length - 1] || {}
					error = r.attempts.map((a) => a.name + ':' + (a.status || a.error)).join(' / ') || (last.error || '429')
				}
			}
		}
	}
	if (!payload) payload = { total: 0, items: [] }
	const cached = fromCache

	if (wantsJson) {
		return new Response(
			JSON.stringify({
				num_results: payload.total || payload.items.length || 0,
				query: q,
				results: payload.items.map((r) => ({
					name: r.repo,
					description: r.desc,
					star_count: r.stars || 0,
					is_official: !!r.official,
					is_automated: false,
				})),
			}),
			{ status: error ? 502 : 200, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } }
		)
	}

	return new Response(searchPage({ q, page, total: payload.total, items: payload.items, base, error, source: payload.from }), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'cache-control': 'public, max-age=120',
			'x-search-source': (payload.from || 'none') + (cached ? ' (cache)' : ''),
		},
	})
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url)
		const path = routePath(url.pathname, env)
		if (path === '/search' || path === '/search/_debug' || path === '/v1/search') {
			return handleSearch(request, url, env, ctx, path)
		}
		return worker.fetch(request, env, ctx)
	},
}
