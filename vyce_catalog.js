'use strict';
/**
 * vyce_catalog.js — 模型目录 + 上游 /api/status 实时状态聚合
 * 对应 hub: wb_catalog.py
 */
const { getJson } = require('./vyce_auth');

// CLI 内置模型目录（上游无 /v1/models 端点）
const MODEL_CATALOG = [
  { id: 'auto', name: 'Auto (server picks)' },
  { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash', context: 512000 },
  { id: 'agnes-3.0', name: 'Agnes 3.0' },
  { id: 'agnes-3.0-flashmark', name: 'Agnes 3.0 Flashmark' },
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', context: 272000, dailyLimit: '25M tokens' },
  { id: 'gpt-6-luna', name: 'GPT 6 Luna', context: 250000 },
  { id: 'deepseek-v4.1', name: 'DeepSeek V4.1' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { id: 'qwen-3.8', name: 'Qwen 3.8' },
];

let cache = { at: 0, json: null };
async function fetchUpstreamStatus() {
  if (Date.now() - cache.at < 60000 && cache.json) return cache.json;
  try {
    const j = await getJson('/api/status');
    if (j && typeof j === 'object') cache = { at: Date.now(), json: j };
  } catch {}
  return cache.json;
}

// OpenAI /v1/models 格式 + 实时状态
async function modelsList() {
  const st = (await fetchUpstreamStatus()) || {};
  const availability = st.models || {};
  const ids = [...new Set([...MODEL_CATALOG.map(m => m.id), ...Object.keys(availability)])];
  return ids.map(id => {
    const c = MODEL_CATALOG.find(m => m.id === id) || {};
    return {
      id, object: 'model', created: 0, owned_by: 'vyce',
      name: c.name || id,
      ...(c.context ? { context_window: c.context } : {}),
      ...(c.dailyLimit ? { daily_limit: c.dailyLimit } : {}),
      status: availability[id] || 'catalog',
    };
  });
}

module.exports = { MODEL_CATALOG, fetchUpstreamStatus, modelsList };
