'use strict';
/**
 * vyce_accounts.js — 账号池：存取、轮询调度、冷却/停用、用量统计
 * 对应 hub: wb_accounts.py
 */
const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).accounts || []; }
  catch { return []; }
}
function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2) + '\n', { mode: 0o600 });
}

let rr = 0;
function pickAccount() {
  const now = Date.now();
  const ok = loadAccounts().filter(a => !a.disabled && (!a.cooldownUntil || a.cooldownUntil < now));
  if (!ok.length) return null;
  return ok[rr++ % ok.length];
}

function markAccount(email, patch) {
  const all = loadAccounts();
  const a = all.find(x => x.email === email);
  if (a) { Object.assign(a, patch); saveAccounts(all); }
}

function upsertAccount(rec) {
  const all = loadAccounts();
  const existing = all.find(x => x.email === rec.email);
  if (existing) Object.assign(existing, rec, { disabled: false, disabledReason: undefined });
  else all.push(rec);
  saveAccounts(all);
  return all.length;
}

function deleteAccount(email) {
  saveAccounts(loadAccounts().filter(a => a.email !== email));
}

function addStats(email, usage, model) {
  const all = loadAccounts();
  const a = all.find(x => x.email === email);
  if (!a) return;
  a.requests = (a.requests || 0) + 1;
  if (usage) {
    a.tokens = (a.tokens || 0) + (usage.total_tokens || 0);
    a.promptTokens = (a.promptTokens || 0) + (usage.prompt_tokens || 0);
    a.completionTokens = (a.completionTokens || 0) + (usage.completion_tokens || 0);
  }
  if (model) {
    a.byModel = a.byModel || {};
    a.byModel[model] = (a.byModel[model] || 0) + (usage?.total_tokens || 0);
  }
  a.lastUsed = new Date().toISOString();
  saveAccounts(all);
}

function publicView(a) {
  return {
    email: a.email, deviceId: a.deviceId,
    disabled: !!a.disabled, reason: a.disabledReason || null,
    cooldown: !!(a.cooldownUntil && a.cooldownUntil > Date.now()),
    requests: a.requests || 0, tokens: a.tokens || 0,
    promptTokens: a.promptTokens || 0, completionTokens: a.completionTokens || 0,
    byModel: a.byModel || {},
    addedAt: a.addedAt, lastUsed: a.lastUsed || null,
  };
}

module.exports = { loadAccounts, saveAccounts, pickAccount, markAccount, upsertAccount, deleteAccount, addStats, publicView };
