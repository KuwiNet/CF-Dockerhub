#!/usr/bin/env python3
"""CF-Dockerhub 自检脚本（无第三方依赖）。

用法：
    python3 test/smoke.py https://docker.example.com
    python3 test/smoke.py https://docker.example.com --e2e     # 真实下载并校验 digest

--e2e 会完整拉取 alpine + 一个 ghcr 镜像，逐层下载并校验 sha256 与 size。
"""
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = "docker/27.0.0 go/go1.21.0 kernel/6.5.0 os/linux arch/amd64"
ACCEPT = (
    "application/vnd.oci.image.index.v1+json, "
    "application/vnd.docker.distribution.manifest.list.v2+json, "
    "application/vnd.oci.image.manifest.v1+json, "
    "application/vnd.docker.distribution.manifest.v2+json"
)

PASSED = []
FAILED = []


def header(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return None


def request(base, path, headers=None, method="GET"):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(base + path, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()
    except Exception as err:  # noqa: BLE001
        return None, {}, str(err).encode()


def check(name, ok, detail=""):
    (PASSED if ok else FAILED).append((name, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ("   " + detail if detail else ""))


def token_from_challenge(base, challenge, repo, service="registry.docker.io"):
    """按 docker 客户端的做法：从 401 挑战的 realm 取地址，附上 service / scope 换 token。"""
    if 'realm="' not in challenge:
        return None
    realm = challenge.split('realm="')[1].split('"')[0]
    if base.startswith("http://") and realm.startswith("https://"):
        realm = "http://" + realm[len("https://"):]
    sep = "&" if "?" in realm else "?"
    url = realm + sep + urllib.parse.urlencode({"service": service, "scope": "repository:%s:pull" % repo})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read()).get("token")
    except Exception:  # noqa: BLE001
        return None


def get_token(base, repo, service="registry.docker.io"):
    status, headers, _ = request(base, "/v2/")
    return token_from_challenge(base, header(headers, "www-authenticate") or "", repo, service)


def basic_checks(base):
    status, headers, _ = request(base, "/v2/")
    challenge = header(headers, "www-authenticate") or ""
    check("/v2/ 返回 401 挑战", status == 401 and 'realm="' in challenge, "status=%s" % status)

    token = get_token(base, "library/alpine")
    check("换取 token", bool(token))
    auth = {"Authorization": "Bearer " + token} if token else {}
    h = dict(auth, Accept=ACCEPT)

    status, headers, body = request(base, "/v2/library/alpine/manifests/latest", h)
    ctype = header(headers, "content-type") or ""
    check("manifest", status == 200 and ("manifest" in ctype or "index" in ctype), "status=%s ctype=%s" % (status, ctype))

    status, headers, body = request(base, "/v2/alpine/manifests/latest", h)
    check("省略 library/ 前缀", status == 200, "status=%s" % status)

    status, headers, body = request(base, "/v2/library/alpine/tags/list", h)
    check("tags/list", status == 200 and b'"name"' in body, "status=%s" % status)

    status, headers, body = request(base, "/v2/library/alpine/manifests/latest", h)
    manifest = json.loads(body) if status == 200 else {}
    if "manifests" in manifest:
        digest = manifest["manifests"][0]["digest"]
        status, headers, body = request(base, "/v2/library/alpine/manifests/" + digest, h)
        manifest = json.loads(body) if status == 200 else manifest
    layer = manifest.get("layers", [{}])[0]
    if layer.get("digest"):
        status, headers, _ = request(base, "/v2/library/alpine/blobs/" + layer["digest"], h, "HEAD")
        check("blob HEAD", status == 200 and header(headers, "content-length") == str(layer["size"]),
              "status=%s len=%s" % (status, header(headers, "content-length")))
        status, headers, _ = request(base, "/v2/library/alpine/blobs/" + layer["digest"], dict(h, Range="bytes=0-999"))
        check("blob Range 续传", status == 206, "status=%s range=%s" % (status, header(headers, "content-range")))

    status, headers, body = request(base, "/_health")
    check("/_health", status == 200 and b'"status"' in body, "status=%s" % status)


def e2e_pull(base, repo, tag, host=None):
    accept = ACCEPT
    qs = ("?hubhost=" + host) if host else ""
    service = host or "registry.docker.io"
    h = {"Accept": accept}
    status, headers, body = request(base, "/v2/%s/manifests/%s%s" % (repo, tag, qs), h)
    if status == 401:
        # 用目标仓库自己的挑战换 token（ghcr / quay 的 realm 与 docker.io 不同）
        challenge = header(headers, "www-authenticate") or ""
        token = token_from_challenge(base, challenge, repo, service)
        if token:
            h["Authorization"] = "Bearer " + token
            status, headers, body = request(base, "/v2/%s/manifests/%s%s" % (repo, tag, qs), h)
    if status != 200:
        check("拉取 %s:%s" % (repo, tag), False, "manifest status=%s" % status)
        return
    manifest = json.loads(body)
    if "manifests" in manifest:
        cand = [m for m in manifest["manifests"] if m.get("platform", {}).get("architecture") == "amd64"]
        digest = cand[0]["digest"]
        status, headers, body = request(base, "/v2/%s/manifests/%s%s" % (repo, digest, qs), h)
        manifest = json.loads(body) if status == 200 else manifest
    blobs = [manifest["config"]] + manifest.get("layers", [])
    total = 0
    ok = True
    for desc in blobs:
        status, headers, blob = request(base, "/v2/%s/blobs/%s%s" % (repo, desc["digest"], qs), h)
        if status != 200:
            ok = False
            continue
        total += len(blob)
        if len(blob) != desc["size"] or hashlib.sha256(blob).hexdigest() != desc["digest"].split(":")[1]:
            ok = False
    check("完整拉取 %s:%s（%d 层，%d 字节，digest 全部校验）" % (repo, tag, len(blobs), total), ok)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    base = sys.argv[1].rstrip("/")
    basic_checks(base)
    if "--e2e" in sys.argv:
        e2e_pull(base, "library/alpine", "latest")
        e2e_pull(base, "stefanprodan/podinfo", "6.4.0", host="ghcr.io")
    print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
    for name, detail in FAILED:
        print("  FAILED: %s %s" % (name, detail))
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
