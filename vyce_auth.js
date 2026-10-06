'use strict';
/**
 * vyce_auth.js — 验证模块：device-code 登录 + Ed25519 请求签名 + 上游传输
 * （替换 hub 的 WorkBuddy OAuth/JWT 验证，协议逆向自官方 CLI v0.1.3）
 * 对应 hub: wb_proxy.py 内的 auth 部分
 */
const https = require('node:https');
const crypto = require('node:crypto');

const BASE = 'https://www.vyce-code.com';
const VERSION = '0.1.3';
const BUILD = 'e6c0a1a8481673fd1512aca610f55e2e50d186b4d11d77ec150800ea1fdf016b'; // 官方 cli.js 的 sha256
const UA = `vyce-code/${VERSION} (node ${process.version}; ${process.platform})`;

// ---------- Ed25519 请求签名 ----------
// 规范串: VYCE1\nmethod\npath\nts\nnonce\nsha256hex(body)\nagent\nversion\nbuild
function signHeaders(acc, method, urlPath, bodyStr) {
  if (!acc.devicePrivateKey || !acc.deviceId) return {};
  const ts = String(Date.now() + (acc.serverSkew || 0));
  const nonce = crypto.randomBytes(16).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
  const canonical = ['VYCE1', method, urlPath, ts, nonce, bodyHash, 'main', VERSION, BUILD].join('\n');
  const sig = crypto.sign(null, Buffer.from(canonical), acc.devicePrivateKey).toString('base64url');
  return {
    'X-Vyce-Device': acc.deviceId,
    'X-Vyce-Ts': ts,
    'X-Vyce-Nonce': nonce,
    'X-Vyce-Agent': 'main',
    'X-Vyce-Version': VERSION,
    'X-Vyce-Build': BUILD,
    'X-Vyce-Machine': acc.machine || crypto.randomBytes(16).toString('hex'),
    'X-Vyce-Sig': sig,
  };
}

// ---------- 上游传输 ----------
function upstream(acc, { method, urlPath, body, accept = 'application/json', stream = false }, onServerTime) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': 'Bearer ' + acc.token,
      'Accept': accept,
      'User-Agent': UA,
      ...signHeaders(acc, method, urlPath, bodyStr),
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(BASE, { method, path: urlPath, headers, timeout: 120000 }, res => {
      if (stream) return resolve({ res, acc });
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const st = Number(res.headers['x-vyce-server-time']);
        if (Number.isFinite(st) && st > 0 && onServerTime) onServerTime(st - Date.now());
        resolve({ status: res.statusCode, headers: res.headers, body: data, acc });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

// ---------- 匿名 JSON 传输（登录流程/状态查询用） ----------
function postJson(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(payload);
    const req = https.request(BASE, {
      method: 'POST', path: urlPath,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(s), 'User-Agent': UA },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null, raw: d }); } });
    });
    req.on('error', reject); req.write(s); req.end();
  });
}
function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    https.get(BASE + urlPath, { headers: { 'Accept': 'application/json', 'User-Agent': UA } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    }).on('error', reject);
  });
}

// ---------- device-code 登录会话 ----------
const loginSessions = new Map(); // id -> {code, authUrl, privateKeyPem, status, email, createdAt, onAuthorized}

async function startLogin(onAuthorized) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const devicePublicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const init = await postJson('/api/auth/cli/init', { devicePublicKey, platform: process.platform, version: VERSION, build: BUILD });
  if (init.status !== 200 || !init.json?.code) {
    throw new Error('init 失败: HTTP ' + init.status + ' ' + (init.raw || JSON.stringify(init.json)));
  }
  const sess = {
    id: crypto.randomBytes(8).toString('hex'),
    code: init.json.code, authUrl: init.json.authUrl,
    privateKeyPem, status: 'pending', email: null, createdAt: Date.now(), onAuthorized,
  };
  loginSessions.set(sess.id, sess);
  pollLogin(sess).catch(() => { sess.status = 'error'; });
  return sess;
}

async function pollLogin(sess) {
  while (Date.now() - sess.createdAt < 5 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await getJson('/api/auth/cli/poll?code=' + encodeURIComponent(sess.code));
    if (poll.status === 'authorized') {
      const email = poll.userEmail || '(unknown)';
      const rec = {
        email, token: poll.token, deviceId: poll.deviceId,
        devicePrivateKey: sess.privateKeyPem,
        machine: crypto.createHash('sha256').update('vyce-machine|' + crypto.randomBytes(16).toString('hex')).digest('hex').slice(0, 32),
        addedAt: new Date().toISOString(),
      };
      sess.status = 'authorized'; sess.email = email;
      if (sess.onAuthorized) sess.onAuthorized(rec);
      return;
    }
    if (poll.status === 'refused' || poll.status === 'expired') { sess.status = poll.status; return; }
  }
  sess.status = 'expired';
}

function getLoginSession(id) { return loginSessions.get(id); }

module.exports = { BASE, VERSION, BUILD, UA, signHeaders, upstream, postJson, getJson, startLogin, getLoginSession };
