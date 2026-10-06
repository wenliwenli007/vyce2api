#!/usr/bin/env node
'use strict';
/**
 * vyce2api — CLI 入口（薄壳）
 *   node vyce2api.js login           添加账号（打开浏览器授权）
 *   node vyce2api.js serve [port]    启动网关（默认 8788），面板 http://127.0.0.1:8788/
 *   node vyce2api.js status          查看账号池
 *   node vyce2api.js key             显示 API Key
 */
const { spawn } = require('node:child_process');
const auth = require('./vyce_auth');
const accounts = require('./vyce_accounts');
const settings = require('./vyce_settings');
const proxy = require('./vyce_proxy');

async function loginCli() {
  const sess = await auth.startLogin(rec => accounts.upsertAccount(rec));
  console.log('\n请在浏览器中完成授权:\n  ' + sess.authUrl + '\n');
  try { spawn('cmd', ['/c', 'start', '', sess.authUrl], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  while (sess.status === 'pending') {
    await new Promise(r => setTimeout(r, 1500));
    process.stdout.write('.');
  }
  if (sess.status === 'authorized') {
    console.log('授权成功: ' + sess.email + '（账号池共 ' + accounts.loadAccounts().length + ' 个）');
  } else {
    console.error('\n授权失败: ' + sess.status);
    process.exit(1);
  }
}

const cmd = process.argv[2];
if (cmd === 'login') loginCli().catch(e => { console.error(e.message || e); process.exit(1); });
else if (cmd === 'serve') proxy.serve(Number(process.argv[3]) || 8788);
else if (cmd === 'status') console.log(JSON.stringify(accounts.loadAccounts().map(accounts.publicView), null, 2));
else if (cmd === 'key') console.log(settings.getApiKey());
else console.log('用法: node vyce2api.js login | serve [port] | status | key');
