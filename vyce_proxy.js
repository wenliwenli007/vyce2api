'use strict';
/**
 * vyce_proxy.js — 主服务：OpenAI 兼容端点 + 面板 API + 请求日志/用量统计
 * 对应 hub: wb_proxy.py（路由面镜像：/panel/* /accounts/* /usage/* /logs /settings /v1/*）
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const auth = require('./vyce_auth');
const accounts = require('./vyce_accounts');
const catalog = require('./vyce_catalog');
const settings = require('./vyce_settings');

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const USAGE_DIR = path.join(__dirname, 'usage');
const STATS_FILE = path.join(USAGE_DIR, 'stats.json');

// ---------- 面板会话（内存，重启失效） ----------
const panelSessions = new Map(); // token -> expiresAt
function newPanelSession() {
  const t = crypto.randomBytes(24).toString('base64url');
  panelSessions.set(t, Date.now() + 12 * 3600 * 1000);
  return t;
}
function checkPanel(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = panelSessions.get(t);
  return !!exp && exp > Date.now();
}
function checkApiKey(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7)
    : new URL(req.url, 'http://x').searchParams.get('key') || '';
  return key === settings.getApiKey();
}

// ---------- 请求日志（内存环形 + JSONL 落盘） ----------
const LOG_CAP = 500;
const requestLog = [];
function logRequest(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > LOG_CAP) requestLog.pop();
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const day = entry.ts.slice(0, 10);
    fs.appendFileSync(path.join(USAGE_DIR, `requests-${day}.jsonl`), JSON.stringify(entry) + '\n');
  } catch {}
  updateStats(entry);
}

// ---------- 累计统计（落盘 usage/stats.json） ----------
let stats = null;
function loadStats() {
  if (stats) return stats;
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { stats = { byModel: {}, byDay: {}, total: { requests: 0, errors: 0, tokens: 0 } }; }
  return stats;
}
function updateStats(e) {
  const s = loadStats();
  const ok = e.status < 400;
  s.total.requests++;
  if (!ok) s.total.errors++;
  s.total.tokens += e.totalTokens || 0;
  const m = s.byModel[e.model] ||= { requests: 0, errors: 0, tokens: 0, totalLatencyMs: 0 };
  m.requests++; if (!ok) m.errors++;
  m.tokens += e.totalTokens || 0;
  m.totalLatencyMs += e.latencyMs || 0;
  const day = e.ts.slice(0, 10);
  const d = s.byDay[day] ||= { requests: 0, tokens: 0 };
  d.requests++; d.tokens += e.totalTokens || 0;
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(s));
  } catch {}
}

// ---------- 工具 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- OpenAI: /v1/models ----------
async function handleModels(req, res) {
  sendJson(res, 200, { object: 'list', data: await catalog.modelsList() });
}

// ---------- OpenAI: /v1/chat/completions ----------
async function handleChat(req, res) {
  const t0 = Date.now();
  const raw = await readBody(req);
  let payload;
  try { payload = JSON.parse(raw); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } }); }
  const model = payload.model || 'auto';
  const wantStream = payload.stream === true;
  payload.stream = true; // 上游统一 SSE, 非流式由本网关聚合

  const acc = accounts.pickAccount();
  if (!acc) return sendJson(res, 503, { error: { message: 'no available account', type: 'server_error' } });

  let up;
  try {
    up = await auth.upstream(acc, {
      method: 'POST', urlPath: '/v1/chat/completions',
      body: payload, accept: 'text/event-stream', stream: true,
    });
  } catch (e) {
    logRequest({ ts: new Date().toISOString(), model, account: acc.email, status: 502, latencyMs: Date.now() - t0, totalTokens: 0, stream: wantStream, error: e.message });
    return sendJson(res, 502, { error: { message: 'upstream connect failed: ' + e.message, type: 'server_error' } });
  }

  const { res: urs } = up;
  if (urs.statusCode === 429 || urs.statusCode === 401 || urs.statusCode === 403) {
    accounts.markAccount(acc.email, urs.statusCode === 429
      ? { cooldownUntil: Date.now() + 60000 }
      : { disabled: true, disabledReason: 'HTTP ' + urs.statusCode });
    urs.resume();
    logRequest({ ts: new Date().toISOString(), model, account: acc.email, status: urs.statusCode, latencyMs: Date.now() - t0, totalTokens: 0, stream: wantStream });
    return sendJson(res, urs.statusCode === 429 ? 429 : 502, { error: { message: `upstream ${urs.statusCode}, account rotated`, type: 'server_error' } });
  }
  if (urs.statusCode >= 400) {
    let d = ''; urs.on('data', c => d += c);
    return urs.on('end', () => {
      logRequest({ ts: new Date().toISOString(), model, account: acc.email, status: urs.statusCode, latencyMs: Date.now() - t0, totalTokens: 0, stream: wantStream });
      res.writeHead(urs.statusCode, { 'Content-Type': 'application/json' });
      res.end(d);
    });
  }

  let buf = ''; // 收集以提取 usage / 聚合
  urs.on('data', c => { if (buf.length < 4 * 1024 * 1024) buf += c; });
  urs.on('end', () => {
    const m = [...buf.matchAll(/"usage":\{[^}]*\}/g)].pop();
    let usage = null;
    if (m) { try { usage = JSON.parse('{' + m[0] + '}').usage; } catch {} }
    accounts.addStats(acc.email, usage, model);
    logRequest({
      ts: new Date().toISOString(), model, account: acc.email, status: 200,
      latencyMs: Date.now() - t0, stream: wantStream,
      promptTokens: usage?.prompt_tokens || 0, completionTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    });
  });

  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    urs.pipe(res);
    req.on('close', () => urs.destroy());
  } else {
    urs.on('end', () => {
      try { sendJson(res, 200, aggregateSse(buf, model)); }
      catch (e) { sendJson(res, 502, { error: { message: 'failed to aggregate stream: ' + e.message, type: 'server_error' } }); }
    });
  }
}

function aggregateSse(sse, model) {
  const msg = { role: 'assistant', content: '' };
  const toolCalls = {};
  let usage = null, finish = null, id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex'), created = Math.floor(Date.now() / 1000);
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.id) id = j.id;
    if (j.created) created = j.created;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) msg.content += d.content;
    for (const tc of d.tool_calls || []) {
      const t = toolCalls[tc.index ?? 0] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.function.name += tc.function.name;
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
    }
  }
  if (Object.keys(toolCalls).length) { msg.tool_calls = Object.values(toolCalls); msg.content = msg.content || null; }
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish || 'stop' }], ...(usage ? { usage } : {}) };
}

// ---------- 路由 ----------
function serve(port = 8788) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      // ---- 面板前端（页面本身开放, 登录由 JS 完成） ----
      if (p === '/' || p === '/panel' || p === '/panel/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(DASHBOARD_FILE));
      }
      if (p === '/health') return sendJson(res, 200, { ok: true });

      // ---- 面板登录（无需会话） ----
      if (p === '/panel/login' && req.method === 'POST') {
        const { password } = JSON.parse(await readBody(req));
        if (!settings.verifyPanelPassword(password)) return sendJson(res, 401, { error: '密码错误' });
        return sendJson(res, 200, { token: newPanelSession(), hasCustomPassword: settings.hasCustomPassword() });
      }
      if (p === '/panel/status') {
        return sendJson(res, 200, { loggedIn: checkPanel(req), hasCustomPassword: settings.hasCustomPassword() });
      }

      // ---- 以下全部需要面板会话 ----
      if (p.startsWith('/panel/') || p.startsWith('/accounts') || p.startsWith('/usage') || p.startsWith('/logs') || p.startsWith('/settings')) {
        if (!checkPanel(req)) return sendJson(res, 401, { error: '未登录' });

        if (p === '/panel/logout' && req.method === 'POST') {
          const h = req.headers.authorization || '';
          panelSessions.delete(h.slice(7));
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/panel/password' && req.method === 'POST') {
          const { oldPassword, newPassword } = JSON.parse(await readBody(req));
          if (!settings.verifyPanelPassword(oldPassword)) return sendJson(res, 403, { error: '原密码错误' });
          if (!newPassword || String(newPassword).length < 4) return sendJson(res, 400, { error: '新密码至少 4 位' });
          settings.setPanelPassword(newPassword);
          return sendJson(res, 200, { ok: true });
        }

        // 账号
        if (p === '/accounts') return sendJson(res, 200, { accounts: accounts.loadAccounts().map(accounts.publicView) });
        if (p === '/accounts/login/start' && req.method === 'POST') {
          const sess = await auth.startLogin(rec => accounts.upsertAccount(rec));
          return sendJson(res, 200, { id: sess.id, authUrl: sess.authUrl });
        }
        if (p === '/accounts/login/poll') {
          const sess = auth.getLoginSession(u.searchParams.get('id'));
          if (!sess) return sendJson(res, 404, { status: 'unknown' });
          return sendJson(res, 200, { status: sess.status, email: sess.email });
        }
        if (p === '/accounts/set' && req.method === 'POST') {
          const { email, disabled } = JSON.parse(await readBody(req));
          accounts.markAccount(email, { disabled: !!disabled, disabledReason: disabled ? '手动停用' : undefined });
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/accounts/delete' && req.method === 'POST') {
          const { email } = JSON.parse(await readBody(req));
          accounts.deleteAccount(email);
          return sendJson(res, 200, { ok: true });
        }

        // 用量
        if (p === '/usage/analytics') {
          const s = loadStats();
          const accs = accounts.loadAccounts().map(accounts.publicView);
          return sendJson(res, 200, {
            total: s.total, byDay: s.byDay,
            accounts: { total: accs.length, ok: accs.filter(a => !a.disabled && !a.cooldown).length, cooldown: accs.filter(a => a.cooldown).length, disabled: accs.filter(a => a.disabled).length },
          });
        }
        if (p === '/usage/by-account') {
          return sendJson(res, 200, { accounts: accounts.loadAccounts().map(accounts.publicView) });
        }
        if (p === '/usage/perf') {
          const s = loadStats();
          const perf = Object.entries(s.byModel).map(([model, m]) => ({
            model, requests: m.requests, errors: m.errors, tokens: m.tokens,
            successRate: m.requests ? +(100 * (m.requests - m.errors) / m.requests).toFixed(1) : 100,
            avgLatencyMs: m.requests ? Math.round(m.totalLatencyMs / m.requests) : 0,
          })).sort((a, b) => b.requests - a.requests);
          return sendJson(res, 200, { perf });
        }
        if (p === '/usage/recent') return sendJson(res, 200, { logs: requestLog.slice(0, 50) });

        // 日志
        if (p === '/logs') return sendJson(res, 200, { logs: requestLog });
        if (p === '/logs/clear' && req.method === 'POST') { requestLog.length = 0; return sendJson(res, 200, { ok: true }); }

        // 设置
        if (p === '/settings') {
          return sendJson(res, 200, {
            apiKey: settings.getApiKey(),
            hasCustomPassword: settings.hasCustomPassword(),
            upstream: auth.BASE,
            version: auth.VERSION,
            port: server.address()?.port,
          });
        }
        if (p === '/settings/apikey/regenerate' && req.method === 'POST') {
          return sendJson(res, 200, { apiKey: settings.regenerateApiKey() });
        }

        return sendJson(res, 404, { error: 'not found' });
      }

      // ---- OpenAI 兼容端点（API Key 鉴权） ----
      if (p.startsWith('/v1/')) {
        if (!checkApiKey(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
        if (p === '/v1/models' && req.method === 'GET') return await handleModels(req, res);
        if (p === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res);
        return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
    }
  });
  server.listen(port, () => {
    const n = accounts.loadAccounts().length;
    console.log(`vyce2api  http://127.0.0.1:${port}/v1  (账号池 ${n} 个)`);
    console.log(`面板      http://127.0.0.1:${port}/  (默认密码 admin)`);
    console.log(`API Key   ${settings.getApiKey()}`);
    if (!n) console.log('提示: 面板中点击「+ 添加账号」完成 OAuth 授权');
  });
  return server;
}

module.exports = { serve };
