'use strict';
// happyhorse 体检（原生 DashScope 异步协议，2026-09-30 验通）：
//   node smoke/happyhorse.js                          # 探测：三个 1.1 模型谁能受理
//   node smoke/happyhorse.js "镜头描述" --img https://… --model happyhorse-1.1-i2v
// ⚠️ 带 prompt 的实跑会真烧一次生成配额，验通路用。
require('../lib/env');
const fs = require('fs');
const hh = require('../lib/happyhorse');
const { CFG } = require('../lib/env');

const BASE = (process.env.HH_API_BASE || '').replace(/\/+$/, '');
const KEY = process.env.HH_API_KEY || CFG.llmKey;

async function probe() {
  for (const m of ['happyhorse-1.1-t2v', 'happyhorse-1.1-i2v', 'happyhorse-1.1-r2v']) {
    const res = await fetch(BASE + '/api/v1/services/aigc/video-generation/video-synthesis', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model: m, input: { prompt: '一只马在草原奔跑' }, parameters: { duration: 5 } }),
      signal: AbortSignal.timeout(30_000),
    });
    const t = await res.text();
    console.log(`${m.padEnd(22)} HTTP ${res.status} ${t.slice(0, 160)}`);
  }
  console.log('（i2v/r2v 受理但缺 media 会跑图失败，属预期；正式验请带 --img）');
}

async function realRun(prompt, img, model) {
  if (model) process.env.HH_VIDEO_MODEL = model;
  const dir = '/tmp/hh-smoke-' + Date.now();
  fs.mkdirSync(dir, { recursive: true });
  console.log(`提交生成（model=${process.env.HH_VIDEO_MODEL || model}）：${prompt}\n首帧：${img || '（无）'}`);
  try {
    const name = await hh.generate(dir, { name: 'smoke', prompt, imageUrl: img, seconds: 5 });
    console.log('✅ 生成成功，产物：', dir + '/assets/' + name);
  } catch (e) {
    console.error('❌ 失败：', e.message);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const getFlag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
const prompt = args[0] && !args[0].startsWith('--') ? args[0] : '';
if (!prompt) probe();
else realRun(prompt, getFlag('--img') || 'https://latiaomei.infinityfly.xin/uploads/charref/latiaomei-three-view.jpg',
  getFlag('--model') || process.env.HH_VIDEO_MODEL);
