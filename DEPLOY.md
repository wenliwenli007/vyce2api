# vyce2api 部署文档（供实施 agent 使用）

> 本文档是自包含的部署指南。按步骤执行并在每步完成验证，全部通过即部署成功。
> 预期总耗时：10–15 分钟（含一次人工浏览器授权）。

---

## 1. 项目概述

vyce2api 把 Vyce Code（https://www.vyce-code.com ，免费 AI 编码模型服务）封装成本地 **OpenAI 兼容 API 网关**，含 Web 管理面板。部署后，任意 OpenAI 客户端（Cherry Studio / NextChat / LobeChat / 自研代码）可用统一 `base_url + api_key` 接入。

- 运行时：Node.js ≥ 18（零 npm 依赖，无需 `npm install`）
- 平台：Windows / Linux / macOS（`start-vyce2api.bat` 仅 Windows；其他系统直接 `node` 启动）
- 验证机制：device-code 浏览器授权 + Ed25519 请求签名（已固化在代码中，部署者无需关心细节）

## 2. 前置条件检查

```bash
node --version    # 要求 >= v18
curl -s https://www.vyce-code.com/api/status   # 能返回 JSON 即网络可达
```

任一不满足则先解决（装 Node / 处理网络）。

## 3. 文件清单

分发包解压后应包含：

```
vyce2api/
├── vyce2api.js        # CLI 入口
├── vyce_proxy.js      # 主服务（路由 + OpenAI 端点 + 日志统计）
├── vyce_auth.js       # 验证模块（device-code 登录 + Ed25519 签名）
├── vyce_accounts.js   # 账号池
├── vyce_catalog.js    # 模型目录
├── vyce_settings.js   # API Key / 面板密码
├── dashboard.html     # 面板前端
├── start-vyce2api.bat # Windows 一键启动
└── README.md
```

**运行时自动生成**（分发包不含，属敏感数据，禁止打包外发）：

```
accounts.json     # 账号凭据（token + 设备私钥），权限 0600
settings.json     # API Key + 面板密码哈希，权限 0600
usage/            # 请求日志与累计统计
```

## 4. 部署步骤

### 4.1 解压并启动

```bash
mkdir -p /opt/vyce2api && cd /opt/vyce2api
tar xzf vyce2api-dist.tar.gz      # 或解压 zip
node vyce2api.js serve 8788       # 前台运行验证；常驻见 §7
```

**验证**：终端输出三行（Base URL / Panel / API Key），无报错。

### 4.2 添加账号（需要一次人工浏览器操作）

1. 浏览器打开 `http://<主机>:8788/`（本机部署即 `http://127.0.0.1:8788/`）；
2. 输入面板密码，默认 `admin`；
3. 进入「👤 账号」页 → 点 **+ 添加账号 (OAuth)**；
4. 浏览器自动打开 vyce-code.com 授权页 → 登录/注册 Vyce 账号（免费）→ 点「批准」；
5. 面板 2 秒内显示「✓ 授权成功」，账号出现在账号池表格中。

**验证（命令行）**：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8788/panel/login \
  -H 'Content-Type: application/json' -d '{"password":"admin"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8788/accounts
# 期望: accounts 数组中有 1 个账号, disabled=false
```

> 无浏览器的纯命令行环境：执行 `node vyce2api.js login`，把打印的授权链接发给有浏览器的人完成批准即可。

### 4.3 修改面板密码（生产必做）

面板「⚙️ 设置」→「面板访问密码」：原密码 `admin` → 新密码（≥4 位）→ 修改。

### 4.4 获取接入信息

「⚙️ 设置」页可复制：
- **Base URL**: `http://<主机>:8788/v1`
- **API Key**: `sk-...`（首次启动自动生成，存于 settings.json）

也可命令行获取：`node vyce2api.js key`

## 5. 端到端验证（全部通过才算完成）

```bash
KEY=$(node vyce2api.js key)

# ① 未授权拒绝
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/v1/models
# 期望: 401

# ② 模型列表
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8788/v1/models | head -c 200
# 期望: {"object":"list","data":[{"id":"auto",...

# ③ 非流式对话
curl -s -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"reply with exactly: OK"}]}'
# 期望: 标准 chat.completion JSON, content 含 OK, 含 usage

# ④ 流式对话
curl -s -N -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":true}' | head -3
# 期望: data: {...chat.completion.chunk...} 逐行输出

# ⑤ 日志与统计（需面板会话 token, 见 4.2）
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8788/logs
# 期望: 刚才两次请求各一条记录（含 latencyMs / totalTokens）
```

## 6. 客户端接入

任意 OpenAI 兼容客户端：协议选 OpenAI，`base_url = http://<主机>:8788/v1`，`api_key = <API Key>`。可用模型：`auto`（推荐，服务端路由）、`agnes-3.0-flash`(512k)、`mimo-v2.6-flash`(272k，25M tokens/天)、`gpt-6-luna`(250k) 等，实时可用性见面板「分析」页。

## 7. 常驻运行

**Windows**：双击 `start-vyce2api.bat`；或计划任务开机启动。
**Linux (systemd)**：

```ini
# /etc/systemd/system/vyce2api.service
[Unit]
Description=vyce2api gateway
After=network.target
[Service]
WorkingDirectory=/opt/vyce2api
ExecStart=/usr/bin/node vyce2api.js serve 8788
Restart=always
[Install]
WantedBy=multi-user.target
```

**macOS / 临时**：`nohup node vyce2api.js serve 8788 > vyce2api.log 2>&1 &`

## 8. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 对话 401 `invalid api key` | 客户端 Key 错误；`node vyce2api.js key` 核对 |
| 对话 401/403 且账号被停用 | 上游 token 失效：面板「账号」页重新 OAuth 授权（同邮箱会覆盖刷新） |
| 对话 502 `client_required` | 上游改了版本校验：重新计算官方 cli.js 的 sha256，更新 `vyce_auth.js` 中 `BUILD` 常量（方法：npm 下载 vyce-code 最新包，`sha256sum dist/cli.js`） |
| 全部账号 429 | 触发 60 req/min 公平限制；账号会自动冷却 60s，可加小号扩容（重复 4.2） |
| 面板登录 401 | 密码错误；忘记密码时删除 `settings.json` 的 `panelPassword` 字段，重启后恢复默认 `admin` |
| `models` 返回目录但状态缺失 | 上游 `/api/status` 不可达，不影响对话 |

## 9. 安全注意事项

1. `accounts.json`（token + 设备私钥）与 `settings.json`（API Key）是全部凭据，**不要提交到 git、不要放进分发包、不要明文粘贴到公共渠道**；
2. 暴露到局域网/公网前必须：改面板密码 + 确认 API Key 为高强度随机值（默认即是）；
3. 上游为免费赞助制服务（60 req/min、3 并发），控制调用强度，滥用有封号风险；
4. 本服务仅供学习研究，遵守 Vyce 服务条款。

## 10. 参考

- 协议逆向细节与调研过程：Obsidian `E:\Vault\2026-10-07_调研VyceCode能否转OpenAI_API.md`
- 架构参照：https://github.com/ardeyouxipianyi/workbuddy2api-hub
- 上游官网：https://www.vyce-code.com
