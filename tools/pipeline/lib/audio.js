'use strict';
// 成片配音/配乐（v11）：每镜旁白走 edge-tts（微软免费 readaloud 接口），
// BGM 用 vendor/bgm 里的 CC-BY 曲目，ffmpeg 侧链闪避（有人说话音乐自动压低），
// 最后 loudnorm 到 -14 LUFS（短视频平台响度标准）并与无声成片混流。
// 铁律：任何一步失败都降级（少一条旁白 / 无 BGM / 完全静音），绝不卡死流水线。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { CFG, ROOT } = require('./env');

const TTS_ENABLED = process.env.TTS_ENABLED !== '0';
const TTS_VOICE = process.env.TTS_VOICE || 'zh-CN-XiaoyiNeural'; // 活泼女声，贴辣条妹人设
// 激情档（2026-10 修订：辣条妹要求播报有激情，不要平铺直叙的机器腔）：
// 普通旁白中等提速提调；金镜（开场/收尾/口头禅/感叹句）再冲一档。
const TTS_RATE = process.env.TTS_RATE || '+15%';
const TTS_PITCH = process.env.TTS_PITCH || '+4Hz';
const HOT_RATE = process.env.TTS_HOT_RATE || '+28%';
const HOT_PITCH = process.env.TTS_HOT_PITCH || '+12Hz';
const HOT_VOLUME = process.env.TTS_HOT_VOLUME || '+8%';
// 命中这些词/位置的句子按“金句激情档”合成（开场镜、CTA 镜也升档）。
const HOT_WORDS = /嘎嘎香|干.{0,3}碗米饭|好吃到|绝了|落胃|！|\?|？/;

// 判断一条旁白该用哪档情绪（i 镜号，n 总镜数）。
function prosody(text, i, n) {
  const hot = i === 0 || i === n - 1 || HOT_WORDS.test(text);
  return hot
    ? { rate: HOT_RATE, pitch: HOT_PITCH, volume: HOT_VOLUME }
    : { rate: TTS_RATE, pitch: TTS_PITCH };
}
// 成片配乐默认关闭（2026-10-05 辣条妹定稿：不要背景音乐，人声清楚、画面优先）。
// 需要 BGM 时在 .env 里 BGM_ENABLED=1 显式打开。
const BGM_ENABLED = process.env.BGM_ENABLED === '1';
const BGM_DIR = process.env.BGM_DIR || path.join(ROOT, 'vendor', 'bgm');
const BGM_VOLUME = Number(process.env.BGM_VOLUME || 0.14);

const ffprobeDur = (f) => {
  try {
    return Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
};

// 单条旁白 → mp3；成功返回 { name, dur }，失败返回 null。prosody 可选：{rate,pitch,volume}。
function tts(text, outPath, pro = {}) {
  const t = String(text || '').replace(/[#*【】\[\]]/g, '，').trim();
  if (t.length < 2) return null;
  const args = ['--voice', TTS_VOICE, '--rate', pro.rate || TTS_RATE];
  if (pro.pitch || TTS_PITCH) args.push('--pitch', pro.pitch || TTS_PITCH);
  if (pro.volume) args.push('--volume', pro.volume);
  args.push('--text', t.slice(0, 120), '--write-media', outPath);
  try {
    cp.execFileSync('edge-tts', args, { timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
    const dur = ffprobeDur(outPath);
    if (!dur || !fs.existsSync(outPath) || fs.statSync(outPath).size < 500) return null;
    return { name: path.basename(outPath), dur };
  } catch { return null; }
}

// 给每个场景合成旁白（就地写 sc.vo / sc.voFile / sc.voDur）。
// 旁白文本优先级：LLM 给的 vo → title+sub 拼接。全部失败也不报错，成片退回静音。
function synthScenes(dir, scenes) {
  if (!TTS_ENABLED) return 0;
  const adir = path.join(dir, 'audio');
  fs.mkdirSync(adir, { recursive: true });
  let ok = 0;
  scenes.forEach((sc, i) => {
    const text = String(sc.vo || '').trim() ||
      [sc.title, sc.sub].filter(Boolean).join('，');
    if (!text) return;
    const got = tts(text, path.join(adir, `vo${i}.mp3`), prosody(text, i, scenes.length));
    if (got) { sc.vo = text; sc.voFile = got.name; sc.voDur = got.dur; ok++; }
  });
  return ok;
}

// 从 happyhorse 说话镜片段里抽出「模型自己对过嘴的那条音轨」，作为本镜配音。
// 2026-10-06 复盘（拿 lipsync-demo.mp4 + lipsync-vo.mp3 实测比对）：喂给模型的
// audio_url 是 edge-tts 的 mp3，但模型回来的 mp4 自带音轨是它按口型重放的版本——
// 起口比原 mp3 晚约 0.85s、中段还有 ±0.3s 漂移。成片若继续铺原 mp3，画面里的嘴
// 永远比声音慢半拍，这就是“唇形和台词对不上”的主因。
// 所以说话镜的配音改用片段自带音轨：声音和嘴出自同一次生成，天然同步。
// 返回 { name, dur }；片段没音轨/抽失败返回 null（调用方退回 edge-tts 版）。
function useClipAudio(dir, clipName, index) {
  const adir = path.join(dir, 'audio');
  const clip = path.join(dir, 'assets', clipName);
  if (!fs.existsSync(clip)) return null;
  try {
    const st = cp.execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', clip],
      { encoding: 'utf8' }).trim();
    if (!st) { console.warn(`[audio] 片段 ${clipName} 无音轨，退回 edge-tts 配音`); return null; }
  } catch { return null; }
  fs.mkdirSync(adir, { recursive: true });
  const name = `hhv${index}.m4a`;
  const out = path.join(adir, name);
  try {
    cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clip, '-vn',
      '-af', 'aformat=sample_rates=44100:channel_layouts=stereo', '-c:a', 'aac', '-b:a', '160k', out],
      { timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.warn(`[audio] 抽 ${clipName} 音轨失败，退回 edge-tts 配音:`, String(e.message || e).slice(0, 120));
    return null;
  }
  const dur = ffprobeDur(out);
  if (!dur || fs.statSync(out).size < 2000) return null;
  return { name, dur };
}

const pickBgm = (seed = 0) => {
  if (!BGM_ENABLED) return null; // 缺省不出 BGM
  let tracks = [];
  try { tracks = fs.readdirSync(BGM_DIR).filter((f) => /\.(mp3|m4a|ogg)$/.test(f)).sort(); } catch { return null; }
  if (!tracks.length) return null;
  return path.join(BGM_DIR, tracks[Math.abs(seed) % tracks.length]);
};

// 按分镜时间轴拼出整条音轨 mix.m4a：旁白对位（adelay）+ BGM 循环 + 侧链闪避 + loudnorm。
// segs: [{start,dur}]（与 render.planTimeline 同源）；total: 成片秒数。失败返回 null。
function mixTrack(dir, scenes, segs, total, { seed = 0 } = {}) {
  const adir = path.join(dir, 'audio');
  const inputs = [];
  const filters = [];
  const voLabels = [];
  let inIdx = 0; // ffmpeg 输入序号（与 -i 个数同步，不能拿 inputs.length 算）

  scenes.forEach((sc, i) => {
    if (!sc.voFile) return;
    const f = path.join(adir, sc.voFile);
    if (!fs.existsSync(f)) return;
    // 说话镜（片段自带音轨 / hh 音频驱动）：配音必须与片段 0 点对齐——画面里的嘴
    // 就是照着这条音动做的，再延 250ms 嘴就永远比声音先动（2026-10-06 复盘）。
    const lead = sc.voClip || (sc.hh && sc.video) ? 0 : 250;
    const ms = Math.round(segs[i].start * 1000) + lead; // 非口播镜留半拍呼吸感
    inputs.push('-i', f);
    filters.push(`[${inIdx}:a]adelay=${ms}|${ms},aformat=sample_rates=44100:channel_layouts=stereo[vo${i}]`);
    inIdx++;
    voLabels.push(`[vo${i}]`);
  });
  if (!voLabels.length && !pickBgm(seed)) return null;

  let narr = '[narr]';
  if (voLabels.length === 1) {
    filters.push(`${voLabels[0]}apad=whole_dur=${total},atrim=0:${total}[narr]`);
  } else if (voLabels.length > 1) {
    filters.push(`${voLabels.join('')}amix=inputs=${voLabels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total},atrim=0:${total}[narr]`);
  }

  const bgm = pickBgm(seed);
  if (bgm) {
    inputs.push('-stream_loop', '-1', '-i', bgm);
    const bi = inIdx;
    inIdx++;
    if (voLabels.length) {
      // ⚠️ [narr] 要同时当 sidechain 信号和混音输入，必须先 asplit 分流：
      // 同一个 pad 直接引用两次会被 ffmpeg 吃掉后半段旁白（2026-10-05 实盘的
      // “只有第一镜有人声、后面只剩 BGM”就是这个 bug）。
      filters.push(`[narr]asplit=2[narr1][narr2]`);
      // 音乐被旁白闪避：旁白响时 BGM 自动压 8:1。
      filters.push(`[${bi}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${BGM_VOLUME},aformat=sample_rates=44100:channel_layouts=stereo[bg]`);
      filters.push(`[bg][narr1]sidechaincompress=threshold=0.05:ratio=8:attack=40:release=600[duck]`);
      filters.push(`[duck][narr2]amix=inputs=2:normalize=0[mix]`);
    } else {
      filters.push(`[${bi}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${BGM_VOLUME * 1.6},aformat=sample_rates=44100:channel_layouts=stereo[mix]`);
    }
  } else {
    filters.push(`[narr]anull[mix]`);
  }
  filters.push(`[mix]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]`);

  const out = path.join(adir, 'mix.m4a');
  const cmd = ['ffmpeg', '-y', '-loglevel', 'error', ...inputs,
    '-filter_complex', filters.join(';'), '-map', '[aout]', '-t', String(total),
    '-c:a', 'aac', '-b:a', '160k', out];
  try {
    cp.execFileSync(cmd[0], cmd.slice(1), { timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    return fs.existsSync(out) && fs.statSync(out).size > 2000 ? out : null;
  } catch { return null; }
}

// 成片 + 音轨混流（视频流直接 copy，不重编码）。
function mux(videoPath, audioPath, outPath) {
  try {
    cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-i', audioPath,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-shortest', outPath],
      { timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000 ? outPath : null;
  } catch { return null; }
}

module.exports = { synthScenes, mixTrack, mux, pickBgm, ffprobeDur, tts, useClipAudio };
