# 哈利波特的神奇日记本 · Riddle

一个致敬汤姆·里德尔日记的浏览器体验:在一张泛黄纸面上用鼠标/手指写字,停笔约 3 秒,墨迹被笔记"喝掉",随后一行手写体从纸面上浮现——像另一头的汤姆在回信。

灵感来自 [MaximeRivest/Riddle](https://github.com/MaximeRivest/Riddle)(跑在 reMarkable Paper Pro 上)。本版本去掉所有设备相关代码(evdev 触控笔、Quill 接管、e-ink waveform),把核心体验搬进纯浏览器:**Python 标准库单文件后端 + 一个 canvas + 纯 JS 手写动画引擎**,任何能开浏览器的机器都能跑。

回信不是直接渲染的文字。每一句流式回复先被 *Dancing Script* 字体光栅化成位图,二值化后用 **Zhang–Suen 细化算法**抽成单像素骨架,再用链码追踪成有序笔划,最后 `requestAnimationFrame` 逐笔重绘——看起来就像一支羽毛笔正在实时书写。全部在 `public/handwriting.js` 里,无 Rust、无 e-ink。

---

## 它能做什么

- **多页流程**:落地页(标题 + 简介 + 配图 + 使用说明 + 钥匙框)→ 钥匙验证 → 日记本 canvas → 右上角 ⚙ 面板临时保存/清除 AI 配置。
- **后台 `/admin`**:账号密码登录后,可生成随机访问钥匙、删除旧钥匙、改管理员账号/密码、查看当前登录账号。生成的钥匙持久化到 `keys.json`。
- **双层鉴权**(互不干扰):
  - `riddle_key` —— 访问令牌,守 `/diary` + `/api/chat` + `/api/defaults`。合法钥匙 = `keys.json` 里所有钥匙 **外加** `.env` 里的 `RIDDLE_ACCESS_TOKEN`(旧后门,不可经 UI 删)。
  - `riddle_admin` —— 管理员会话(内存 `ADMIN_TOKENS`,重启即清),只守 `/api/admin/genkey` + `listkeys` + `delkey` + `changepw` + `whoami`。
- **SSE 流式代理** `/api/chat`——把任意 OpenAI 兼容视觉端点接到日记本上。墨迹图片随消息一起发出去,所以模型要能"看懂"你写的字。
- **视觉模型**:MODEL 字段带 datalist,下拉提示一批能读手写体的视觉模型;要识别**中文手写**,优先 Qwen-VL 系列(`qwen/qwen2.5-vl-72b-instruct` 等),见使用说明。
- **高 DPI & 移动端自适应**:`devicePixelRatio` 锐化 + `RX()` 缩放系数 + `100dvh`,安卓/iPhone/iPad 都不糊不挤。

---

## 依赖

- Python 3.10+(3.13 已实测)。**只用标准库**(`http.server`),无 pip 依赖,无 Flask/FastAPI/Django。
- 一个 OpenAI 兼容的视觉模型端点(OpenAI / OpenRouter / Groq / NVIDIA NIM / 本地 Ollama / 任意自托管)。留空也跑——会回落到内置离线 mock,纯本地玩手写动画。

---

## 本地快速跑(单机调试)

```bash
git clone https://github.com/jeffreyrobeson/riddle.git
cd riddle
cp .env.example .env       # 按需填写
python3 server.py
# 默认端口来自 .env 的 RIDDLE_PORT(示例 9000);未设则默认 80(需 root)
# 打开 http://localhost:9000/
```

无 API key 时日记仍能回复(内置 mock);要把回声换成真模型,见下文。

---

## 环境变量(`.env`)

| 变量 | 说明 |
|---|---|
| `RIDDLE_PORT` | 监听端口。默认 80(需 root);公网常用 9000 等高位端口。 |
| `RIDDLE_OPENAI_BASE` | OpenAI 兼容 `/v1` 端点。如 `https://integrate.api.nvidia.com/v1`。 |
| `RIDDLE_OPENAI_KEY` | Bearer token。**留空**则日记回落到离线 mock。 |
| `RIDDLE_OPENAI_MODEL` | 模型 id。必须是**视觉模型**才能看懂你写的字。 |
| `RIDDLE_ACCESS_TOKEN` | 旧式后门访问令牌(一把长随机串)。任何持此串者可进日记;不经 UI 删除。新钥匙改在后台生成。 |
| `RIDDLE_ADMIN_USER` | `/admin` 登录账号。 |
| `RIDDLE_ADMIN_PASS` | `/admin` 登录密码;改密后台会**原地改写本文件并重启服务**。 |

⚠️ `.env` 与 `keys.json` 含密钥,**切勿提交版本库**(已列在 `.gitignore`)。`.env.example` 是给你的模板,可推。

### 本地最小配置(只验证手写动画,不接模型)

```bash
# .env
RIDDLE_PORT=9000
RIDDLE_OPENAI_KEY=
RIDDLE_ADMIN_USER=admin
RIDDLE_ADMIN_PASS=换成你自己的强密码
```

### 接真模型(以 NVIDIA NIM 视觉模型为例,能读手写)

```bash
RIDDLE_PORT=9000
RIDDLE_OPENAI_BASE=https://integrate.api.nvidia.com/v1
RIDDLE_OPENAI_KEY=nvapi-...
RIDDLE_OPENAI_MODEL=meta/llama-3.2-11b-vision-instruct
RIDDLE_ADMIN_USER=admin
RIDDLE_ADMIN_PASS=换成你自己的强密码
# RIDDLE_ACCESS_TOKEN=optional-legacy-backdoor   # 留空即靠后台生成的钥匙
```

> 前端 ⚙ 面板里填的配置存浏览器 `localStorage`,会**覆盖**上面的服务端默认值;API key 建议只在面板里填,不要写进 `.env`。

### 路由速查

| 路由 | 页面 | 访问令牌网关 |
|---|---|---|
| `/` | `landing.html`(标题/简介/图/使用说明/钥匙框) | 公开 |
| `/diary` | `diary.html`(canvas 日记本) | 需钥匙 |
| `/admin` | `admin.html`(登录 / 生成删钥匙 / 改账号密码) | 公开(内层另由管理员 cookie 守) |
| `/api/check_key` | 验证钥匙 | 公开 |
| `/api/chat` | SSE 流式代理(花你的 LLM token) | 需钥匙 |
| `/api/defaults` | 给前端 ⚙ 面板的 provider / 默认值 / 视觉模型清单 | 需钥匙 |
| `/api/admin/*` | 后台用 | 管理员 cookie |

钥匙可通过任一方式提供:`?key=<钥匙>`、`Authorization: Bearer <钥匙>`、或 `riddle_key` cookie。比较用 `hmac.compare_digest`,常数时间。

---

## 公网部署(任意 Linux 服务器,可复制)

下面这套在生产实测于 Ubuntu + 宝塔面板 nginx,但**每一步都是标准 Linux**,换 Debian/CentOS/caddy 等只是把 nginx 换成你的反代。

### 方式 A:裸跑(最快,适合自用/内网)

```bash
git clone https://github.com/jeffreyrobeson/riddle.git /opt/riddle
cd /opt/riddle
cp .env.example .env && nano .env     # 照上表填
python3 server.py                     # 前台;或 nohup / tmux 里跑
```

公网要加防火墙开放 `RIDDLE_PORT`。但裸跑无 TLS、无限流——**别长期裸暴露**。

### 方式 B:systemd + nginx 反代 + HTTPS(推荐公网)

#### 1. 落代码 & 配 `.env`

```bash
git clone https://github.com/jeffreyrobeson/riddle.git /opt/riddle
cd /opt/riddle
cp .env.example .env
nano .env          # 照上表填全,尤其 RIDDLE_ADMIN_* 两个
```

#### 2. systemd 常驻

把下面存到 `/etc/systemd/system/riddle.service`(按你的安装路径调整 `WorkingDirectory` / `ExecStart` / `.env` 路径):

```
[Unit]
Description=Riddle — Tom Riddle's diary (local web app)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/riddle
EnvironmentFile=/opt/riddle/.env
ExecStart=/usr/bin/python3 /opt/riddle/server.py
Restart=on-failure
RestartSec=3
StandardOutput=append:/opt/riddle/riddle.log
StandardError=append:/opt/riddle/riddle.log

[Install]
WantedBy=multi-user.target
```

启用:

```bash
systemctl daemon-reload
systemctl enable --now riddle
systemctl status riddle            # active (running) 即好
journalctl -u riddle -n 30 --no-pager
# 或 tail -f /opt/riddle/riddle.log
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9000/   # → 200
```

> 改密以后端会自重写 `.env` 再 `systemctl restart riddle`。所以 `.env` 必须可由服务用户读写。

#### 3. nginx 反代(含 SSE 关键配置)

日记本回信是 **Server-Sent Events** 流式,nginx 默认会缓冲,会把流死死卡住。`/api/chat` 必须**关缓冲 + 拉长超时**。这是部署里最容易踩的坑。

部署示例(非宝塔环境,自己写的 vhost):

```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name riddle.example.com;

    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    # SSE: 长连接,必须关缓冲、拉长超时,否则流式回信卡死
    location /api/chat {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        chunked_transfer_encoding on;
    }

    # 其余一切走标准反代
    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

宝塔面板用户注意(实测踩坑):宝塔默认的两条静态规则——

```
location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)$ { expires 30d; ... }
location ~ .*\.(js|css)?$               { expires 12h; ... }
```

——优先级高于 `location /`,会把对 `.css`/`.js`/`.jpg` 的请求**劫持到 webroot 找本地文件**而不反代,结果 404。本站是纯反代应用,这两条**必须注释掉**,否则样式/脚本/主页配图都装不上。

重载:`nginx -t && nginx -s reload`(宝塔:`/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload`)。

#### 4. HTTPS 证书

任选其一:宝塔/1Panel 面板一键 Let's Encrypt、`certbot --nginx`、或 Caddy(自带自动证书)。证书一旦部署,`RIDDLE_PORT` 绑 `127.0.0.1` 只听本地、对外只走 nginx 443 最稳。

#### 5. 第一次进后台生成钥匙

```bash
# 直接打 API(或浏览器开 /admin 登录)
curl -s -c /tmp/c.txt -X POST http://127.0.0.1:9000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"user":"admin","pass":"你在.env设的密码"}'
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:9000/api/admin/genkey
# → {"ok":true,"key":"<新钥匙>","keys":[...]}
```

把返回的 `key` 贴到落地页钥匙框 → 进日记。新钥匙即时生效(写进内存 `VALID_KEYS`,并落 `keys.json`,重启不丢)。

---

## 日常运维

| 操作 | 命令 |
|---|---|
| 重启 riddle | `systemctl restart riddle` |
| 重载 nginx | `nginx -t && nginx -s reload` |
| 看日志 | `tail -f /opt/riddle/riddle.log` 或 `journalctl -u riddle -f` |
| 改管理员账/密 | 后台 `/admin` → "修改账号信息" → 服务自动重启 |
| 生成/删除访问钥匙 | 后台 `/admin` → "生成新钥匙" / 每行"删除" |
| 删除 `.env` 后门令牌 | 无 UI;不想要后门就把 `.env` 里 `RIDDLE_ACCESS_TOKEN` 留空 |

---

## 项目结构

```
server.py              # 单文件后端:路由 / 两层鉴权 / SSE 代理 / 后台 API / 钥匙持久化
.env / .env.example    # 运行时配置(勿提交)/ 模板
keys.json              # 后台生成的访问钥匙(勿提交;首次启动自动建)
public/
  landing.html         # 落地页(标题/简介/配图/使用说明/钥匙框)
  landing.js           # 落地页:钥匙验证跳转
  diary.html           # 日记本页(canvas + ⚙ 配置面板)
  app.js               # 日记控制流 / SSE / 配置面板 / 高 DPI & 移动端自适应
  handwriting.js       # 手写动画引擎(Dancing Script 光栅化 → Zhang-Suen 细化 → 笔划追踪 → 逐笔重绘)
  admin.html / admin.js   # 后台页 + 客户端(登录、生成/删钥匙、改账密、whoami)
  style.css            # 共用:暗色旧羊皮纸调色板(落地/日记/后台三页共用)
  riddle.jpg           # 落地页配图
systemd unit 见上文,路径按安装位置调整
```

---

## 安全说明

这不是一个产品级服务:Python `http.server`,单线程池、无审计日志、无限流。**别长期裸暴露公网**——前面挡一层 nginx + HTTPS、限制访问 IP,或绑 `127.0.0.1` 只让反代碰。鉴权层防的是"随便一个扫描器消耗你的 LLM token",不是对抗性渗透。

`.env` / `keys.json` 全部在 `.gitignore`;**别**把真实密钥提交。`.env.example` 是模板,推上去无妨。

---

## 致谢

- [MaximeRivest/Riddle](https://github.com/MaximeRivest/Riddle) —— 原始 reMarkable 版本,本作的灵感来源。
- [Dancing Script](https://fonts.google.com/specimen/Dancing+Script) / [EB Garamond](https://fonts.google.com/specimen/EB+Garamond) —— Google Fonts。
- Zhang & Suen, *A Fast Parallel Algorithm for Thinning Digital Patterns* —— 骨架细化算法。
