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
const cp = require('child_process');
const { CFG } = require('./env');

const MODEL = () => (process.env.HH_VIDEO_MODEL || '').trim();
// 注意：这里是原生网关根地址（不带 /compatible-mode/v1），与 LLM_API_BASE 不同，必须显式配。
const BASE = () => (process.env.HH_API_BASE || '').trim().replace(/\/+$/, '');
const KEY = () => (process.env.HH_API_KEY || CFG.llmKey);
// 单镜等待上限（秒）。实测 5s 竖屏生成约 4-5 分钟。
const WAIT_SECS = Number(process.env.HH_WAIT_SECS || 900);

const available = () => !!(MODEL() && BASE() && KEY());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffprobeDur = (f) => {
  try {
    return Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
};

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
// 提交生成。imageUrl：公网可达首帧参考（定妆图/实拍图）；audioUrl：公网可达配音（主播口播镜）。
// 2026-10-05 实盘：happyhorse-1.1-i2v 支持 input.audio_url 音频驱动口型，
// 片段时长会跟随音频长度变长（duration 提下限），嘴型跟台词对得上。
async function submit({ prompt, imageUrl = '', audioUrl = '', seconds = 5 }) {
  const body = {
    model: MODEL(),
    input: {
      prompt,
      ...(audioUrl ? { audio_url: audioUrl } : {}),
      ...(imageUrl ? { media: [{ type: 'first_frame', url: imageUrl }] } : {}),
    },
    parameters: { duration: Math.max(3, Math.min(15, Math.round(seconds))) },
  };
  return api('/api/v1/services/aigc/video-generation/video-synthesis', body, 'POST', { 'X-DashScope-Async': 'enable' });
}

const query = (id) => api(`/api/v1/tasks/${encodeURIComponent(id)}`, null, 'GET');

// 一站式：提交 → 轮询 → 下载到 dir/assets/{name}.mp4。失败抛错，调用方降级。
// 片段体检（2026-10-06 实盘：happyhorse 会回“全黑废片”，旧版直接剪进成片 → 观众看到黑屏）。
// 抽 N 帧算亮度均值与帧间差异：全黑 / 完全静止 / 视频流比容器短（尾帧黑）都判废。
// 返回 { ok, reason, videoDur, mean, motion }。
function inspectClip(dir, name, samples = 7, refImg = '') {
  const file = path.join(dir, 'assets', String(name).endsWith('.mp4') ? name : `${name}.mp4`);
  const out = { ok: false, reason: '', videoDur: 0, mean: 0, motion: 0 };
  if (!fs.existsSync(file)) { out.reason = '片段不存在'; return out; }
  // 1) 视频流真实时长（容器时长会被音频拉长，按容器定镜长→尾部几帧黑屏）
  try {
    const s = cp.execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-of', 'default=nw=1', file], { encoding: 'utf8' });
    const vd = Number((s.match(/duration=([\d.]+)/) || [])[1] || 0);
    const container = ffprobeDur(file);
    out.videoDur = vd > 0 ? Math.min(vd, container || vd) : (container || 0);
  } catch { out.videoDur = ffprobeDur(file); }
  // 2) 抽样帧算亮度与帧间差（缩到 48x85 灰度，纯 JS 算，不依赖 numpy）
  const frames = [];
  try {
    const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', file,
      '-vf', `fps=${Math.max(2, Math.min(4, samples))},scale=48:85`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 32 * 1024 * 1024 });
    for (let o = 0; o + 48 * 85 <= raw.length; o += 48 * 85) frames.push(raw.subarray(o, o + 48 * 85));
  } catch { /* 抽帧失败下面判废 */ }
  if (frames.length < 2) { out.reason = '抽帧失败（疑似损坏/非视频）'; return out; }
  let mean = 0;
  for (const f of frames) { for (let i = 0; i < f.length; i++) mean += f[i]; }
  mean /= frames.length * frames[0].length;
  let motion = 0;
  for (let k = 1; k < frames.length; k++) {
    let d = 0;
    for (let i = 0; i < frames[k].length; i++) d += Math.abs(frames[k][i] - frames[k - 1][i]);
    motion += d / frames[k].length;
  }
  motion /= frames.length - 1;
  out.mean = +mean.toFixed(1); out.motion = +motion.toFixed(2);
  if (mean < 24) { out.reason = `画面全黑（均亮 ${out.mean}）`; return out; }
  if (mean > 236) { out.reason = `画面全白（均亮 ${out.mean}）`; return out; }
  if (motion < 0.6) { out.reason = `片段几乎静止（帧间差 ${out.motion}，多半卡帧废片）`; return out; }
  if (out.videoDur < 1.5) { out.reason = `视频流仅 ${out.videoDur}s，太短不可用`; return out; }
  // 两个画面稳定性指标（2026-10-06 实盘校准）：
  //   refDiff = 片段首帧 vs 定妆参考图：太大说明模型没照首帧起画；
  //   drift   = 片段首帧 vs 尾帧：太大说明它在镜头里“走景”（实盘拿灰底全身立绘做首帧时
  //             4 秒内推到特写、背景还换了一间屋子，开头一秒嘴是闭着笑的 → 观众看到就是
  //             “台词和口型对不上”）。旧片段实测 drift 49~85，换「说话态半身定妆图」后应显著下降。
  const grab = (args) => {
    try {
      return cp.execFileSync('ffmpeg', ['-v', 'error', ...args, '-vf', 'scale=48:85', '-pix_fmt', 'gray',
        '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 8 * 1024 * 1024 });
    } catch { return null; }
  };
  const mad = (a, b) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i] - b[i]); return +(d / Math.min(a.length, b.length)).toFixed(1); };
  const f0 = grab(['-ss', '0.1', '-i', file]);
  const f1 = grab(['-ss', Math.max(0.2, out.videoDur - 0.15).toFixed(2), '-i', file]);
  if (f0 && f1) {
    out.drift = mad(f0, f1);
    if (out.drift > 45) { out.reason = `镜头内走景太狠（首尾差 ${out.drift}，观众会看到换景/换嘴型）`; return out; }
  }
  if (refImg && fs.existsSync(refImg) && f0) {
    const ref = grab(['-i', refImg]);
    if (ref) {
      out.refDiff = mad(f0, ref);
      if (out.refDiff > 40) { out.reason = `首帧没照定妆图起画（差 ${out.refDiff}）`; return out; }
    }
  }
  out.ok = true;
  return out;
}

// 一站式：提交 → 轮询 → 下载到 dir/assets/{name}.mp4 → 重编码成“渲染友好”版。失败抛错，调用方降级。
// 重编码（2026-10-06 复盘）：happyhorse 回来的 mp4 关键帧很稀（实测间隔 3s+），
// hyperframes 渲染日志直接告警 “sparse keyframes … causes seek failures and frame freezing”，
// 抽帧定位不准则会出现“嘴停在某个口型上但声音还在说”的唇形错位。这里统一转成
// 30fps + 每秒一个关键帧（不改分辨率，交给渲染层 object-fit:cover 处）。
function normalizeClip(dir, name) {
  const src = path.join(dir, 'assets', `${name}.mp4`);
  const dst = path.join(dir, 'assets', `${name}-norm.mp4`);
  try {
    cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30',
      '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dst],
      { timeout: 6 * 60_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
    if (!fs.existsSync(dst) || fs.statSync(dst).size < 20 * 1024) return false;
    fs.renameSync(dst, src);
    return true;
  } catch (e) {
    // 重编码失败不阻断：用原片继续渲染（宁可帧稀也不丢镜头）。
    console.warn(`[hh] 片段 ${name} 重编码失败，用原片:`, String(e.message || e).slice(0, 120));
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

async function generate(dir, { name, prompt, imageUrl = '', audioUrl = '', seconds = 5 }) {
  if (!available()) throw new Error('happyhorse 未配置（HH_VIDEO_MODEL / HH_API_BASE）');
  const created = await submit({ prompt, imageUrl, audioUrl, seconds });
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
  const dest = path.join(dir, 'assets', `${name}.mp4`);
  await download(url, dest);
  normalizeClip(dir, name);
  return `${name}.mp4`;
}

// 下载并落盘（体积门：小于 50KB 多半不是视频）。
async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`happyhorse 成片下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50 * 1024) throw new Error('happyhorse 返回体积异常（<50KB，多半不是视频）');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// 批量生成（2026-10-06）：全程主播口播模式一跑就是 5-7 个口播镜，串行等单镜（每镜 4-5 分钟）
// 太慢。这里先一次性提交（隔 1.5s 提一单，避免瞬时限流），再并发轮询、逐个下载。
// 单镜失败不影响其他镜：返回与 items 等长的结果数组 [{name, clip|error}]。
async function generateBatch(dir, items = []) {
  if (!available()) throw new Error('happyhorse 未配置');
  const tasks = [];
  for (const it of items) {
    try {
      const created = await submit({ prompt: it.prompt, imageUrl: it.imageUrl, audioUrl: it.audioUrl, seconds: it.seconds });
      const id = created?.output?.task_id;
      if (!id) throw new Error('响应缺 task_id：' + JSON.stringify(created).slice(0, 160));
      tasks.push({ ...it, id, out: created.output, done: false, url: '', err: '' });
      console.log(`[hh] 已提交 ${it.name}（task=${id}，${it.seconds}s）`);
    } catch (e) {
      console.warn(`[hh] 提交 ${it.name} 失败:`, String(e.message).slice(0, 160));
      tasks.push({ ...it, id: '', out: null, done: true, url: '', err: String(e.message).slice(0, 200) });
    }
    await sleep(1500); // 提单隔一下，别把网关惹毛
  }
  const deadline = Date.now() + WAIT_SECS * 1000;
  while (!tasks.every((t) => t.done) && Date.now() < deadline) {
    await sleep(10_000);
    for (const t of tasks) {
      if (t.done || !t.id) continue;
      try {
        const out = (await query(t.id)).output || {};
        t.out = out;
        if (out.task_status === 'SUCCEEDED') { t.url = out.video_url || ''; t.done = true; if (!t.url) t.err = 'SUCCEEDED 但无 video_url'; }
        else if (out.task_status === 'FAILED' || out.task_status === 'CANCELED') { t.done = true; t.err = `${out.task_status}: ${out.code || ''} ${out.message || ''}`.slice(0, 200); }
      } catch (e) { t.err = String(e.message).slice(0, 200); t.done = true; }
    }
    const left = tasks.filter((t) => !t.done).length;
    if (left) console.log(`[hh] 等待中 ${left}/${tasks.length} 单…`);
  }
  const res = [];
  for (const t of tasks) {
    if (!t.done) { res.push({ name: t.name, error: '等待超时' }); continue; }
    if (!t.url) { res.push({ name: t.name, error: t.err || '无成片地址' }); continue; }
    try {
      await download(t.url, path.join(dir, 'assets', `${t.name}.mp4`));
      normalizeClip(dir, t.name);
      res.push({ name: t.name, clip: `${t.name}.mp4` });
    } catch (e) { res.push({ name: t.name, error: String(e.message).slice(0, 200) }); }
  }
  return res;
}

module.exports = { available, generate, generateBatch, inspectClip, MODEL };
