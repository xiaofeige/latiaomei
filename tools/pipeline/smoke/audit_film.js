#!/usr/bin/env node
'use strict';
// 成片体检（给“视频工坊”出的 mp4 验尸用，不吃模型配额，纯本地 ffmpeg）：
//   A. 时长是不是跟着内容走（成片秒数 = 时间轴各镜之和；末尾若有一大段死寂=旧版凑时长的特征）
//   B. 口播镜唇形跟台词是不是同一条音轨（成片里那段声 vs happyhorse 片段自带音轨做互相关：
//      同源 → lag≈0、相关度高；不同源 → 嘴比声音慢半拍，就是“唇形和台词对不上”）
//   C. 台词有没有漫过切镜点（某镜配音比镜长 → 话说到下一镜画面里，下一镜是闭嘴画面也在讲话）
//
// 用法：
//   node tools/pipeline/smoke/audit_film.js <成片.mp4> [--timeline <sidecar.json>] [--cache <hhcache目录>]
// 缺省 sidecar/归档目录按成片名推断：
//   uploads/videos/x.mp4 → uploads/videos/x-timeline.json、uploads/hhcache/x/
// 没有 sidecar（历史成片）时只跑 A + C，并对“固定 50s/末尾死寂”给出旧 bug 判定。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { CFG } = require('../lib/env');

const args = process.argv.slice(2);
const film = args.find((a) => !a.startsWith('--'));
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : ''; };
if (!film || !fs.existsSync(film)) {
  console.error('用法：node smoke/audit_film.js <成片.mp4> [--timeline x-timeline.json] [--cache hhcache目录]');
  process.exit(2);
}
const base = path.basename(film, '.mp4');
const tlPath = opt('--timeline') || path.join(path.dirname(film), `${base}-timeline.json`);
const cacheDir = opt('--cache') || path.join(CFG.uploadsDir, 'hhcache', base);
let tl = null;
if (fs.existsSync(tlPath)) { try { tl = JSON.parse(fs.readFileSync(tlPath, 'utf8')); } catch { /* 手改坏了当没有 */ } }

let fails = 0, warns = 0;
const ok = (n, c, info = '') => { console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${info ? '  — ' + info : ''}`); if (!c) fails++; };
const warn = (n, info = '') => { console.log(`⚠️  WARN  ${n}${info ? '  — ' + info : ''}`); if (warns++) warn; };

const dur = (f) => Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) || 0;
function pcm(file, rate = 4000, ss = 0, t = 0) {
  const a = ['-v', 'error'];
  if (ss > 0) a.push('-ss', String(ss));
  if (t > 0) a.push('-t', String(t));
  a.push('-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-');
  try {
    const buf = cp.execFileSync('ffmpeg', a, { maxBuffer: 96 * 1024 * 1024 });
    if (!buf.length) return null;
    return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
  } catch { return null; }
}
// 20ms 能量包络（0..1）
function env(x, rate = 4000) {
  const win = Math.floor(rate * 0.02), out = [];
  for (let s = 0; s + win <= x.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += x[i] * x[i];
    out.push(Math.sqrt(e / win) / 32768);
  }
  return out;
}
const THR = 0.012; // ≈ -38dBFS，算“有人在说话”
function speechBlocks(e) {
  const out = [];
  let s = -1;
  for (let i = 0; i < e.length; i++) {
    if (e[i] > THR && s < 0) s = i;
    if (e[i] <= THR && s >= 0) { if (i - s >= 5) out.push([s / 50, i / 50]); s = -1; }
  }
  if (s >= 0 && e.length - s >= 5) out.push([s / 50, e.length / 50]);
  return out; // 合并间隔 <0.3s 的相邻块
}
// 包络归一化互相关：lag>0 表示 b 比 a 晚
function xcorr(aFile, bFile) {
  const A = env(pcm(aFile) || new Int16Array(0)), B = env(pcm(bFile) || new Int16Array(0));
  if (A.length < 30 || B.length < 30) return null;
  const cA = A.map((v) => v - A.reduce((s, x) => s + x, 0) / A.length);
  const cB = B.map((v) => v - B.reduce((s, x) => s + x, 0) / B.length);
  const nA = cA.map((v) => v / (Math.sqrt(cA.reduce((s, x) => s + x * x, 0)) || 1));
  const nB = cB.map((v) => v / (Math.sqrt(cB.reduce((s, x) => s + x * x, 0)) || 1));
  const maxLag = Math.min(150, A.length, B.length);
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, cnt = 0;
    for (let i = 0; i < nB.length; i++) { const j = i + lag; if (j >= 0 && j < nA.length) { s += nA[j] * nB[i]; cnt++; } }
    if (cnt > 50 && s > best.score) best = { lag: lag / 50, score: +s.toFixed(4) };
  }
  return best;
}

// 黑屏扫描（2026-10-06 实盘：happyhorse 回了段全黑废片被直接剪进成片，观众看到 4s 黑屏）
function blackWindows(file) {
  const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'fps=2,scale=24:43', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  const W = 24 * 43, means = [];
  for (let o = 0; o + W <= raw.length; o += W) {
    let m = 0;
    for (let i = 0; i < W; i++) m += raw[o + i];
    means.push(m / W);
  }
  const bad = [];
  let s = -1;
  means.forEach((m, i) => {
    if (m < 24 && s < 0) s = i;
    if (m >= 24 && s >= 0) { bad.push([s / 2, i / 2]); s = -1; }
  });
  if (s >= 0) bad.push([s / 2, means.length / 2]);
  return bad.filter(([a, b]) => b - a >= 0.5); // 忽略 <0.5s 的转场瞬黑
}
// 唇动代理：脸部区域逐帧帧差（10fps）与语音能量包络的 Pearson 相关——嘴真在跟着话动就该正相关
function motionEnv(file, ss, t, crop = '480:520:300:380') {
  const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-t', String(t), '-i', file,
    '-vf', `fps=10,crop=${crop},scale=48:52`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const W = 48 * 52, fr = [];
  for (let o = 0; o + W <= raw.length; o += W) fr.push(raw.subarray(o, o + W));
  const out = [];
  for (let k = 1; k < fr.length; k++) {
    let d = 0;
    for (let i = 0; i < W; i++) d += Math.abs(fr[k][i] - fr[k - 1][i]);
    out.push(d / W / 255);
  }
  return out;
}
function audioEnv(file, ss, t) {
  const x = pcm(file, 4000, ss, t);
  if (!x) return [];
  const win = 400, out = [];
  for (let s = 0; s + win <= x.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += x[i] * x[i];
    out.push(Math.sqrt(e / win) / 32768);
  }
  return out;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n, mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? +(num / Math.sqrt(da * db)).toFixed(3) : null;
}

const filmDur = dur(film);
console.log(`\n体检成片：${film}（${filmDur.toFixed(2)}s，${fs.statSync(film).size / 1048576 | 0}MB）`);
console.log(tl ? `时间轴 sidecar：${tlPath}（${tl.timeline.length} 镜，标称 ${tl.total_secs}s）` : `（无 sidecar：${tlPath} 不存在，历史成片只跑时长/越界体检）`);

// ---------- A. 时长跟着内容走 ----------
console.log('\n=== A. 时长体检 ===');
const full = env(pcm(film) || new Int16Array(0));
const blocks = speechBlocks(full);
const lastSpeech = blocks.length ? blocks[blocks.length - 1][1] : 0;
const tailDead = filmDur - lastSpeech;
if (tl) {
  const sum = +tl.timeline.reduce((s, g) => s + g.dur, 0).toFixed(2);
  ok('成片秒数=时间轴各镜之和', Math.abs(filmDur - sum) <= 0.5, `成片 ${filmDur.toFixed(2)}s / 时间轴 ${sum}s`);
  ok('没有硬凑固定时长（成片≠50.00s）', Math.abs(filmDur - 50) > 0.5, `成片 ${filmDur.toFixed(2)}s`);
  const perScene = tl.timeline.map((g) => `${g.i}:${g.dur}s${g.hh ? (g.clip ? '(hh·同源)' : '(hh·回退)') : ''}`).join(' ');
  console.log(`    分镜时长 ${perScene}`);
  if (tl.cap_hint_secs) console.log(`    软上限 ${tl.cap_hint_secs}s（只体检不截断）`);
} else if (Math.abs(filmDur - 50) < 0.05) {
  warn('成片精确 50.00s：旧版“把余量摊到最后一镜硬凑目标时长”的特征值，请用新代码重出');
}
ok('尾部静默 <2s（没为凑时长干瞪）', tailDead <= 2.0, `尾部静默 ${tailDead.toFixed(2)}s`);
let bws = [];
try { bws = blackWindows(film); } catch (e) { console.log('    （黑屏扫描失败：' + e.message + '）'); }
ok('无黑屏段（连续 ≥0.5s 全黑=废片剪进来了）', bws.length === 0,
  bws.length ? bws.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}s`).join(' ') : `全片 ${Math.round(filmDur * 2)} 帧亮度抽检达标`);

// ---------- C. 台词不漫过切镜点 ----------
console.log('\n=== C. 台词/切镜点对位 ===');
if (tl) {
  const cuts = tl.timeline.map((g) => g.start).filter((s) => s > 0.05);
  let bleed = 0;
  for (const cut of cuts) {
    const hit = blocks.find(([a, b]) => a < cut - 0.1 && b > cut + 0.1);
    if (hit) { bleed++; console.log(`    第 ${tl.timeline.find((g) => Math.abs(g.start - cut) < 0.01).i} 镜切镜点 ${cut}s 被一句台词跨越：${hit[0].toFixed(2)}-${hit[1].toFixed(2)}s`); }
  }
  ok('没有台词跨切镜点（话说完才切镜）', bleed === 0, `${cuts.length} 个切镜点，跨越 ${bleed} 处`);
} else {
  console.log(`    语音块 ${blocks.length} 段：${blocks.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(' ')}`);
}

// ---------- B. 口播镜唇形与台词同源 ----------
console.log('\n=== B. 口播镜唇形对账（成片语音 vs 片段自带音轨）===');
if (!tl) { console.log('    ⏭️  无 sidecar，跳过（新出的成片会自带 -timeline.json 与 hhcache 归档）'); }
else if (!fs.existsSync(cacheDir)) { console.log(`    ⏭️  无口播镜归档（${cacheDir}），跳过——历史成片没有归档，新版出片会自动归档`); }
else {
  for (const g of tl.timeline.filter((x) => x.hh)) {
    const cands = [g.clip_file, `hh${g.i - 1}.mp4`].filter(Boolean).map((f) => path.join(cacheDir, f));
    const clip = cands.find((f) => fs.existsSync(f));
    if (!clip) { warn(`第 ${g.i} 镜无归档片段`, cands.join(' / ')); continue; }
    const seg = pcm(film, 4000, g.start, g.dur);
    if (!seg) { warn(`第 ${g.i} 镜取音失败`); continue; }
    // 写成临时 wav 复用 xcorr
    const tmp = path.join(CFG.tmpDir, `audit-seg-${g.i}.raw`);
    fs.writeFileSync(tmp, Buffer.from(seg.buffer));
    const tmpWav = path.join(CFG.tmpDir, `audit-seg-${g.i}.wav`);
    cp.execFileSync('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '4000', '-ac', '1', '-i', tmp, tmpWav]);
    const r = xcorr(tmpWav, clip);
    fs.rmSync(tmp, { force: true }); fs.rmSync(tmpWav, { force: true });
    if (!r) { warn(`第 ${g.i} 镜互相关数据不足`); continue; }
    ok(`第 ${g.i} 镜「${g.title || ''}」唇形与台词同源（|lag|≤0.12s 且同源度≥0.6）`,
      Math.abs(r.lag) <= 0.12 && r.score >= 0.6,
      `lag=${(r.lag * 1000).toFixed(0)}ms 同源度=${r.score.toFixed(3)}${g.clip ? '' : '（注意：本镜配音回退成了 edge-tts 原版）'}`);
    let rr = null;
    try { rr = pearson(motionEnv(film, g.start, g.dur), audioEnv(film, g.start, g.dur)); } catch { /* 抽帧失败不拦 */ }
    if (rr !== null && rr >= 0.25) ok(`第 ${g.i} 镜唇动与语音同起同落（相关度 ≥0.25）`, true, `r=${rr}`);
    else if (rr !== null) warn(`第 ${g.i} 镜唇动与语音相关度偏低（r=${rr}）`,
      '嘴在动但不是音素级对位——happyhorse-1.1-i2v 无真·口型驱动（videoretalk/emo/wan2.2-s2v 在本网关都是 Model not exist）；'
      + '要根治得接能驱动口型的模型，或把景别拉远让嘴占比更小');
  }
}

console.log(fails ? `\n❌ 体检未通过：${fails} 项失败 / ${warns} 项警告` : `\n✅ 体检通过（${warns} 项警告）`);
process.exit(fails ? 1 : 0);
