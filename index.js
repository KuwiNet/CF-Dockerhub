/**
 * CF-Dockerhub 部署入口（2026-11-16）
 *
 * 为什么多一层入口：worker.js 的 registry 代理逻辑不动，只在这里额外接住
 *   /search      —— 首页搜索框跳转的路径（原来会掉进 handleLanding 直接 404）
 *   /v1/search   —— 老版 docker search 客户端用的路径（上游 registry 早已下线，必 404）
 * 搜索改调 hub.docker.com/v2/search/repositories/（匿名可访问、字段稳定、带分页）。
 *
 * wrangler.toml 的 main 指向本文件；其余请求原样交给 worker.js。
 */

import worker from './worker.js'

const SEARCH_UPSTREAM = 'https://hub.docker.com/v2/search/repositories/'
const SEARCH_PAGE_SIZE = 25

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

async function fetchSearch(q, page) {
	const target = new URL(SEARCH_UPSTREAM)
	target.searchParams.set('query', q)
	target.searchParams.set('page', String(page))
	target.searchParams.set('page_size', String(SEARCH_PAGE_SIZE))
	const res = await fetch(target.href, {
		headers: { 'user-agent': 'cf-dockerhub-search', accept: 'application/json' },
		cf: { cacheTtl: 300, cacheEverything: true },
	})
	if (!res.ok) throw new Error('upstream ' + res.status)
	return await res.json()
}

function resultRows(results, base) {
	if (!results.length) return '<p class="empty">没有匹配的镜像，换个关键词试试。</p>'
	return results
		.map((r) => {
			const repo = r.repo_name || ''
			const official = !!r.is_official || /^library\//.test(repo)
			const desc = r.short_description || '（无描述）'
			const pull = 'docker pull ' + base.replace(/^https?:\/\//, '') + '/' + repo
			const badge = official ? '<span class="badge">官方</span>' : ''
			const stars = r.star_count == null ? '' : '<span class="meta">★ ' + esc(r.star_count) + '</span>'
			const pulls = r.pull_count == null ? '' : '<span class="meta">↓ ' + esc(r.pull_count) + '</span>'
			return (
				'<div class="card"><div class="head"><a class="name" href="/?q=' +
				encodeURIComponent(repo) +
				'" rel="nofollow">' +
				esc(repo) +
				'</a>' +
				badge +
				stars +
				pulls +
				'</div><p class="desc">' +
				esc(desc) +
				'</p><div class="cmd"><code>' +
				esc(pull) +
				'</code><button class="copy" data-cmd="' +
				esc(pull) +
				'">复制</button></div></div>'
			)
		})
		.join('')
}

function searchPage({ q, page, total, results, base, error }) {
	const pages = Math.max(1, Math.ceil((total || 0) / SEARCH_PAGE_SIZE))
	const prev = page > 1 ? '<a href="/search?q=' + encodeURIComponent(q) + '&page=' + (page - 1) + '">← 上一页</a>' : '<span></span>'
	const next = page < pages ? '<a href="/search?q=' + encodeURIComponent(q) + '&page=' + (page + 1) + '">下一页 →</a>' : '<span></span>'
	const summary = error ? '<p class="empty">搜索上游暂时不可用：' + esc(error) + '</p>' : '<p class="summary">共 ' + esc(total) + ' 个结果 · 第 ' + esc(page) + ' / ' + esc(pages) + ' 页</p>'
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
.empty{color:rgba(255,255,255,.8);padding:18px;background:rgba(255,255,255,.06);border-radius:12px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px 18px;margin-bottom:12px}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.name{color:#fff;font-size:16px;font-weight:700;text-decoration:none;word-break:break-all}
.name:hover{text-decoration:underline}
.badge{font-size:12px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.18)}
.meta{font-size:12px;color:rgba(255,255,255,.65)}
.desc{color:rgba(255,255,255,.8);font-size:14px;line-height:1.5;margin-bottom:10px;word-break:break-word}
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
${summary}
${error ? '' : resultRows(results, base)}
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

async function handleSearch(request, url, env, path) {
	const q = (url.searchParams.get('q') || '').trim()
	const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1)
	const base = baseOf(url, env)
	const wantsJson = path === '/v1/search' || (request.headers.get('accept') || '').includes('application/json')

	let data = null
	let error = ''
	try {
		data = q ? await fetchSearch(q, page) : { count: 0, results: [] }
	} catch (err) {
		error = (err && err.message) || 'unknown'
	}

	if (wantsJson) {
		const results = ((data && data.results) || []).map((r) => ({
			name: r.repo_name || '',
			description: r.short_description || '',
			star_count: r.star_count || 0,
			is_official: !!r.is_official,
			is_automated: false,
		}))
		return new Response(
			JSON.stringify({ num_results: data ? data.count || results.length : 0, query: q, results }),
			{ status: error ? 502 : 200, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } }
		)
	}

	return new Response(
		searchPage({ q, page, total: (data && data.count) || 0, results: (data && data.results) || [], base, error }),
		{ status: error ? 502 : 200, headers: { 'content-type': 'text/html; charset=UTF-8', 'cache-control': 'public, max-age=120' } }
	)
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url)
		const path = routePath(url.pathname, env)
		if (path === '/search' || path === '/v1/search') {
			return handleSearch(request, url, env, path)
		}
		return worker.fetch(request, env, ctx)
	},
}
