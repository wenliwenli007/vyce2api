# vyce2api

把 [Vyce Code](https://www.vyce-code.com)（免费终端 AI 编码 CLI）封装成 **OpenAI 兼容 API**，架构镜像 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)：模块拆分 + 账号池调度 + 全功能 Web 面板。零依赖，仅需 Node.js ≥ 18。

## 快速开始

```bash
start-vyce2api.bat            # Windows 双击即启（打印 Base URL / API Key）
node vyce2api.js serve 8788   # 或手动启动
node vyce2api.js login        # CLI 方式添加账号（也可在面板中加）
node vyce2api.js status       # 账号池状态
node vyce2api.js key          # 显示 API Key
```

- **面板**: `http://127.0.0.1:8788/`（默认密码 `admin`，在「设置」页修改）
- **Base URL**: `http://127.0.0.1:8788/v1`
- **API Key**: 启动时打印，存于 `settings.json`（自动生成，面板「设置」页可复制/重新生成）

## 架构（镜像 hub）

```
vyce2api.js       CLI 入口（薄壳）
vyce_proxy.js     主服务：路由 + OpenAI 端点 + 日志/统计        ≈ wb_proxy.py
vyce_auth.js      验证模块：device-code 登录 + Ed25519 签名    ≈ hub 的 WorkBuddy OAuth（已替换）
vyce_accounts.js  账号池：CRUD、轮询、冷却/停用、用量统计      ≈ wb_accounts.py
vyce_catalog.js   模型目录 + /api/status 实时状态              ≈ wb_catalog.py
vyce_settings.js  API Key + 面板密码（PBKDF2）                 ≈ wb_settings.py
dashboard.html    面板前端（分析/账号/日志/设置 四页）          ≈ dashboard.html
usage/            请求日志 JSONL + 累计统计 stats.json
```

## 面板功能

| 页面 | 内容 |
|---|---|
| 📊 分析 | 指标卡片、模型性能表（成功率/时延/tokens）、账号用量透视、模型库与能力清单 |
| 👤 账号 | 账号池表格（启停/删除）、OAuth 加号（浏览器批准自动入库） |
| 📜 日志 | 实时请求流水（模型/账号/状态/时延/tokens），可清空 |
| ⚙️ 设置 | API Key 复制/重新生成、面板密码修改、网关信息 |

## API 面（镜像 hub 命名）

- 面板：`/panel/login` `/panel/logout` `/panel/status` `/panel/password`
- 账号：`/accounts` `/accounts/login/start` `/accounts/login/poll` `/accounts/set` `/accounts/delete`
- 用量：`/usage/analytics` `/usage/by-account` `/usage/perf` `/usage/recent`
- 日志：`/logs` `/logs/clear`；设置：`/settings` `/settings/apikey/regenerate`
- OpenAI：`/v1/models` `/v1/chat/completions`（`Authorization: Bearer <API Key>`）

## 模型

`auto`（服务端路由）、`agnes-3.0-flash`(512k)、`agnes-3.0`、`agnes-3.0-flashmark`、`mimo-v2.6-flash`(272k, 25M/天)、`gpt-6-luna`(250k)、`deepseek-v4.1`、`glm-5.3-flash`、`qwen-3.8`。流式含 `reasoning_content`；上游限制 60 req/min。

## 验证机制（替换 WorkBuddy 验证模块，逆向自官方 CLI v0.1.3）

- **登录**：Ed25519 设备密钥对 → `POST /api/auth/cli/init` → 浏览器授权 → 轮询 `/api/auth/cli/poll` → `{token, deviceId}` 入池
- **签名**：每请求 `X-Vyce-*` 头，Ed25519 签名规范串 `VYCE1\nmethod\npath\nts\nnonce\nsha256hex(body)\nagent\nversion\nbuild`，服务端校验 `client_required`
- **调度**：round-robin；429 冷却 60s；401/403 停用；网络错误换号重试

## 免责声明

仅供学习研究。Vyce 为免费赞助制服务，请遵守其服务条款与公平使用限制，滥用有封号风险。
