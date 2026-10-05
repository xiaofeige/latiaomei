'use strict';
// 极简 .env 加载：process.env 优先，.env 兜底。不引第三方依赖。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, dflt = '') => (process.env[k] || dflt).trim();
const envInt = (k, dflt) => {
  const n = parseInt(process.env[k] || '', 10);
  return Number.isFinite(n) ? n : dflt;
};

module.exports = {
  ROOT,
  env,
  envInt,
  CFG: {
    // 后端（Go 服务，本机回环）
    apiBase: env('PIPELINE_BASE', 'http://127.0.0.1:18821'),
    token: env('PIPELINE_TOKEN'),
    // LLM（OpenAI 兼容端点：bailian compatible-mode / token-plan 均可）
    llmBase: env('LLM_API_BASE', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    llmKey: env('LLM_API_KEY'),
    llmModel: env('LLM_MODEL', 'qwen3.8-flash'),
    // 渲染
    tmpDir: env('RENDER_TMP', '/data/tmp/hf'),
    hyperframesBin: path.join(ROOT, 'node_modules/hyperframes/bin/hyperframes.mjs'),
    gsapVendor: path.join(ROOT, 'vendor/gsap.min.js'),
    // 产物落位（复用后端 /uploads/ 静态服务）
    uploadsDir: env('UPLOADS_DIR', '/data/www/latiaomei/data/uploads'),
    // 轮询节奏
    pollSecs: envInt('POLL_SECS', 20),
    idleSleepSecs: envInt('IDLE_SLEEP_SECS', 120),
    videoDailyCap: envInt('VIDEO_DAILY_CAP', 2),
    // 平台凭证（缺了就降级为"产出草稿/成品文件"，不报错）
    gzh: { appid: env('GZH_APPID'), secret: env('GZH_SECRET') },
    wxmini: { appid: env('MP_APPID'), secret: env('MP_SECRET') },
    douyin: { appid: env('DY_APPID'), secret: env('DY_SECRET') },
    // happyhorse（token-plan 视频生成）：模型名为空 = 关闭，人物镜头退回图卡渲染。
    hh: {
      model: env('HH_VIDEO_MODEL'),
      base: env('HH_API_BASE'),
      key: env('HH_API_KEY'),
      maxShots: envInt('HH_MAX_SHOTS', 4), // 单条成片最多交给 happyhorse 几镜（耗时/烧配额）
    },
  },
};
