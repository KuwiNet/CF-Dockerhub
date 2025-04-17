# Docker 镜像代理

## 简介

这是一个基于 Cloudflare Workers 的 Docker 镜像代理服务，旨在帮助用户加速访问 Docker Hub 及其他容器镜像仓库，同时提供一定的功能扩展和自定义选项。

## 功能特点

  * **多镜像源支持** ：支持路由到多个镜像源，包括 Quay.io、GCR.io、k8s.gcr.io、registry.k8s.io、ghcr.io、docker.cloudsmith.io 和 nvcr.io 等，用户可通过主机名快速切换目标仓库。
  * **自定义首页伪装** ：可将首页伪装成 nginx 默认页面或加载指定的外部页面，如 Docker Hub 镜像搜索界面，有效屏蔽爬虫访问。
  * **请求处理优化** ：对包含特殊字符（如 %2F 和 %3A）的请求进行处理，确保请求路径正确性；修改 /v2/ 请求路径，提升请求效率。
  * **认证与重定向处理** ：处理 Docker Registry 认证请求，修改 Www-Authenticate 头信息；对重定向请求进行特殊处理，保障用户访问流畅性。
  * **缓存与性能优化** ：设置合理的缓存时间，减少重复请求，提高服务性能。

## 使用方法

### 部署到 Cloudflare Workers

  1. 将代码部署到你的 Cloudflare Workers 环境中。
  2. 在 Worker 中设置相关环境变量（如 UA、URL 等），以满足个性化需求。

### 访问代理服务

通过配置好的 Worker 域名访问 Docker 镜像资源，例如：<https://your-worker-domain.com/v2/library/nginx/manifests/latest> 。

### 自定义配置（可选）

  * 若要修改屏蔽爬虫的 UA 列表，可在代码中调整 `屏蔽爬虫UA` 数组，或通过设置环境变量 UA 来动态扩展列表。
  * 如需自定义首页内容，可修改 `nginx()` 函数返回的 HTML 内容，或通过设置环境变量 URL 指向其他页面。

## 环境变量说明

  * **UA** ：用于补充屏蔽爬虫的 UA 列表，多个 UA 之间用逗号分隔。
  * **URL** ：指定首页要加载的外部页面 URL，若设置为 “nginx”，则首页显示 nginx 伪装页；若设置其他有效 URL，则加载对应页面。
  * **URL302** ：用于设置首页的临时重定向目标地址，当有值时，访问首页会重定向到该地址。
    
   修改 `worker.js` 中下列代码中`https://kuwinet.github.io/d-proxy` 配置 Docker 镜像搜索页面：
   ```bash
   const response = await fetch('https://kuwinet.github.io/d-proxy'); // 替换为实际的外部网页 URL
   ```

## 注意事项

  1. 本项目依赖 Cloudflare Workers 环境运行，需先注册并配置好 Cloudflare 账号及相关设置。
  2. 在使用过程中，请确保遵守各镜像源的服务条款和使用政策，合理使用代理服务。
  3. 若遇到请求失败或其他问题，可查看 Cloudflare Workers 的日志信息，根据报错提示进行排查和解决。

## 如何使用

### 步骤一：注册与登录 Cloudflare

  1. 访问 [Cloudflare 官网](https://www.cloudflare.com/) 并注册账号。
  2. 登录后，添加你的域名并完成相关配置。

### 步骤二：创建 Cloudflare Worker

  1. 在 Cloudflare 仪表盘中，点击 “Workers” 选项。
  2. 点击 “Create a Worker” 按钮，进入代码编辑界面。

### 步骤三：部署代码

  1. 将上述提供的完整代码粘贴到 Cloudflare Worker 的代码编辑器中。
  2. 点击 “Save and Continue” 保存代码。

### 步骤四：配置环境变量（可选）

  1. 在 Worker 的 “Settings” 页面中，找到 “Variables” 部分。
  2. 添加你需要的环境变量，如 UA、URL 或 URL302。

### 步骤五：发布 Worker

  1. 在代码编辑器页面，点击 “Deploy” 按钮。
  2. 选择 “Deploy to production” 将 Worker 发布到生产环境。

### 步骤六：配置域名解析（可选）

  1. 在 Cloudflare 仪表盘中，进入 “DNS” 页面。
  2. 添加一条 A 记录或 CNAME 记录，将你的自定义域名指向 Cloudflare 分配的 Worker URL。

### 步骤七：使用代理服务

  1. 使用 Docker 客户端或任何支持 Docker Registry API 的工具访问你的代理服务。
  2. 示例命令：
     * 搜索并拉取镜像：
       ```bash
       docker search https://docker.arelay.cn/library/nginx
       ```
     * 拉取镜像：

       ```bash
       docker pull docker.arelay.cn/library/nginx:latest
       ```
  3.一键设置镜像加速：修改文件 /etc/docker/daemon.json（如果不存在则创建）
  
       sudo mkdir -p /etc/docker
       sudo tee /etc/docker/daemon.json <<-'EOF'
       {
         "registry-mirrors": ["docker.arelay.cn"]
       }
       EOF
       sudo systemctl daemon-reload
       sudo systemctl restart docker


### 步骤八：监控与维护

  1. 在 Cloudflare 仪表盘中，查看 Worker 的运行状态和统计信息。
  2. 定期检查日志，及时处理可能出现的错误或性能问题。
