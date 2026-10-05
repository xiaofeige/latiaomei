'use strict';
// happyhorse（token-plan 视频生成）客户端 —— 原生 DashScope 异步协议（2026-09-30 实盘验通）：
//   提交 POST {HH_API_BASE}/api/v1/services/aigc/video-generation/video-synthesis
//        头 X-DashScope-Async: enable，体 {model, input:{prompt, media:[{type:'first_frame',url}]}, parameters:{duration}}
//   轮询 GET  {HH_API_BASE}/api/v1/tasks/{task_id} → output.task_status / output.video_url
// 模型选型：happyhorse-1.1-i2v（图生视频）。三个可用模型里 t2v 虽最便宜但吃不了定妆图，
// 不满足"视频主角必须是辣条妹三视图形象"；i2v 是能挂定妆图的首帧参考里最便宜的（r2v 最贵）。
// 参考图必须公网可达：定妆图就在本站 /uploads/charref/ 下，直接传绝对 URL，不再 base64。
// 降级铁律：未配置/失败一律由调用方兜住退回图卡渲染，绝不卡流水线。
const fs = require('fs');
const path = require('path');
const { CFG } = require('./env');

const MODEL = () => (process.env.HH_VIDEO_MODEL || '').trim();
// 注意：这里是原生网关根地址（不带 /compatible-mode/v1），与 LLM_API_BASE 不同，必须显式配。
const BASE = () => (process.env.HH_API_BASE || '').trim().replace(/\/+$/, '');
const KEY = () => (process.env.HH_API_KEY || CFG.llmKey);
// 单镜等待上限（秒）。实测 5s 竖屏生成约 4-5 分钟。
const WAIT_SECS = Number(process.env.HH_WAIT_SECS || 900);

const available = () => !!(MODEL() && BASE() && KEY());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body, method = 'POST', headers = {}) {
  const res = await fetch(BASE() + pathname, {
    method,
    headers: { authorization: 'Bearer ' + KEY(), 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 下面统一报 */ }
  if (!res.ok || (j && j.code && !j.output)) {
    const err = new Error(`happyhorse HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.retryable = res.status === 429 || res.status >= 500 || /throttl|timeout/i.test(text);
    throw err;
  }
  return j || {};
}

// 提交生成。imageUrl：公网可达的首帧参考（主角定妆图 / 项目素材图）。
async function submit({ prompt, imageUrl = '', seconds = 5 }) {
  const body = {
    model: MODEL(),
    input: {
      prompt,
      ...(imageUrl ? { media: [{ type: 'first_frame', url: imageUrl }] } : {}),
    },
    parameters: { duration: Math.max(3, Math.min(10, Math.round(seconds))) },
  };
  return api('/api/v1/services/aigc/video-generation/video-synthesis', body, 'POST', { 'X-DashScope-Async': 'enable' });
}

const query = (id) => api(`/api/v1/tasks/${encodeURIComponent(id)}`, null, 'GET');

// 一站式：提交 → 轮询 → 下载到 dir/assets/{name}.mp4。失败抛错，调用方降级。
async function generate(dir, { name, prompt, imageUrl = '', seconds = 5 }) {
  if (!available()) throw new Error('happyhorse 未配置（HH_VIDEO_MODEL / HH_API_BASE）');
  const created = await submit({ prompt, imageUrl, seconds });
  const id = created?.output?.task_id;
  if (!id) throw new Error('happyhorse 响应缺 task_id：' + JSON.stringify(created).slice(0, 200));
  const deadline = Date.now() + WAIT_SECS * 1000;
  let out = created.output;
  while (Date.now() < deadline) {
    await sleep(10_000);
    out = (await query(id)).output || {};
    if (out.task_status === 'SUCCEEDED') break;
    if (out.task_status === 'FAILED' || out.task_status === 'CANCELED') {
      throw new Error(`happyhorse ${out.task_status}: ${out.code || ''} ${out.message || ''}`.slice(0, 300));
    }
  }
  const url = out && out.video_url;
  if (!url) throw new Error(`happyhorse 等待超时（${WAIT_SECS}s，task=${id}）`);
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`happyhorse 成片下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50 * 1024) throw new Error('happyhorse 返回体积异常（<50KB，多半不是视频）');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', `${name}.mp4`), buf);
  return `${name}.mp4`;
}

module.exports = { available, generate, MODEL };
