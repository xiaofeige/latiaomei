#!/usr/bin/env node
'use strict';
// 辣条妹内容流水线 worker：领任务 → 按类型分发 → 回填结果。
// 单并发（这台 1.6G 共享机渲染时不能再塞活）。新渠道：jobs/ 里加一个模块即自动注册。
const path = require('path');
const fs = require('fs');
const { CFG } = require('./lib/env');
const api = require('./lib/api');
const publishers = require('./lib/publishers');

const JOBS = {};
for (const f of fs.readdirSync(path.join(__dirname, 'jobs'))) {
  if (!f.endsWith('.js')) continue;
  const m = require(path.join(__dirname, 'jobs', f));
  if (m?.type && m?.run) JOBS[m.type] = m;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
process.on('SIGTERM', () => { stopping = true; log('收到 SIGTERM，干完手头任务就退'); });
process.on('SIGINT', () => { stopping = true; });

async function once() {
  const { tasks } = await api.poll(1, 3);
  if (!tasks.length) return false;
  const t = tasks[0];
  const job = JOBS[t.type];
  log(`领到任务 #${t.id} ${t.type} review=${t.review_id}`);
  try {
    await api.claim(t.id);
    if (!job) throw new Error(`worker 不认识任务类型 ${t.type}`);
    const out = await job.run(t);
    await api.finish(t.id, out.status, JSON.stringify(out.result ?? {}), out.note || '');
    log(`任务 #${t.id} → ${out.status} ${out.note || ''}`);
  } catch (e) {
    log(`任务 #${t.id} 失败:`, e.message);
    // v13：项目步骤任务终结时同步回写 step，不让工作区里的步骤卡在 running。
    const syncStep = async (status, note) => {
      const sid = Number(t.payload?.step_id) || 0;
      if (t.type === 'project_step' && sid) {
        await api.finishProjectStep(sid, status, '', status === 'failed' ? String(note).slice(0, 500) : '', note).catch(() => {});
      }
    };
    if (/quota|insufficient_quota/i.test(e.message)) {
      // LLM 套餐周配额烧穿：不烧重试次数，尽量顺到官方重置点（解析失败则 12h 后）。
      let delay = 12 * 3600;
      const m = e.message.match(/reset at (\d{2})-(\d{2}) (\d{2}):(\d{2})/);
      if (m) {
        const now = Math.floor(Date.now() / 1000);
        let ts = Date.UTC(+new Date().getUTCFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]) / 1000;
        if (ts < now) ts += 7 * 86400; // 跨年了
        delay = Math.max(600, ts - now + 300);
      }
      await api.finish(t.id, 'skipped', '', `LLM 配额耗尽，顺延 ${Math.round(delay / 3600 * 10) / 10}h：` + e.message.slice(0, 200)).catch(() => {});
      await syncStep('skipped', `LLM 配额耗尽，顺延至 ${new Date(Date.now() + delay * 1000).toISOString().slice(0, 16)} 自动重跑`);
      // 顺延重排时把原 payload 带上（social_gen 的四平台清单、发布任务的 item_id 都靠它）。
      await api.enqueue(t.type, t.review_id, Math.floor(Date.now() / 1000) + delay, t.payload || null).catch(() => {});
      log(`任务 #${t.id} 因 LLM 配额顺延 ${Math.round(delay / 360)} / 10 小时`);
    } else {
      await syncStep('failed', e.message);
      await api.finish(t.id, 'failed', '', String(e.message).slice(0, 500)).catch(() => {});
    }
  }
  return true;
}

async function main() {
  if (!CFG.token) { console.error('PIPELINE_TOKEN 未配置（复制 .env.example 为 .env）'); process.exit(1); }
  fs.mkdirSync(CFG.tmpDir, { recursive: true });
  log(`worker 启动，任务类型: ${Object.keys(JOBS).join(', ')}，空闲轮询 ${CFG.pollSecs}s`);
  // 启动即提醒：社媒发布凭证没配齐之前，机器人只会产“发布包”不会自动发。
  const missing = publishers.reminders();
  if (missing.length) {
    log(`⚠️ 社媒自动发布未就绪（${missing.length} 项）——请编辑 ${publishers.FILE} ：`);
    for (const m of missing) log('   · ' + m);
  } else {
    log('社媒四平台（抖音/小红书/知乎/微博）发布配置就绪 ✓');
  }
  while (!stopping) {
    try {
      const busy = await once();
      if (!busy) await sleep((CFG.pollSecs) * 1000);
    } catch (e) {
      log('轮询异常:', e.message);
      await sleep(CFG.idleSleepSecs * 1000); // 后端挂了/网络抖动时别刷日志
    }
  }
  log('worker 退出');
}

// 支持 `node worker.js --once` 手动跑一轮（调试/冒烟用）
if (process.argv.includes('--once')) {
  (async () => { const b = await once(); process.exit(b ? 0 : 2); })();
} else main();
