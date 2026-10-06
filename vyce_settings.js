'use strict';
/**
 * vyce_settings.js — 网关设置（API Key、面板密码），落盘 settings.json
 * 对应 hub: wb_settings.py
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const LEGACY_KEY_FILE = path.join(__dirname, 'gateway-key.txt');

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { cache = {}; }
  // 迁移：旧版 gateway-key.txt -> settings.json
  if (!cache.apiKey) {
    try {
      const k = fs.readFileSync(LEGACY_KEY_FILE, 'utf8').trim();
      if (k) cache.apiKey = k;
    } catch {}
  }
  if (!cache.apiKey) {
    cache.apiKey = 'sk-' + crypto.randomBytes(24).toString('base64url');
    save();
  } else if (!fs.existsSync(SETTINGS_FILE)) save();
  return cache;
}

function save() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
}

function getApiKey() { return load().apiKey; }

function regenerateApiKey() {
  load().apiKey = 'sk-' + crypto.randomBytes(24).toString('base64url');
  save();
  return cache.apiKey;
}

// 面板密码：PBKDF2-SHA256 摘要存储（与 hub 一致，不存明文），默认 admin
function verifyPanelPassword(pwd) {
  const s = load();
  if (!s.panelPassword) return pwd === 'admin';
  try {
    const [salt, expect] = s.panelPassword.split('$');
    const got = crypto.pbkdf2Sync(String(pwd), salt, 100000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect));
  } catch { return false; }
}

function setPanelPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  load().panelPassword = salt + '$' + crypto.pbkdf2Sync(String(pwd), salt, 100000, 32, 'sha256').toString('hex');
  save();
}

function hasCustomPassword() { return !!load().panelPassword; }

module.exports = { getApiKey, regenerateApiKey, verifyPanelPassword, setPanelPassword, hasCustomPassword };
