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
const TTS_RATE = process.env.TTS_RATE || '+10%';
const BGM_DIR = process.env.BGM_DIR || path.join(ROOT, 'vendor', 'bgm');
const BGM_VOLUME = Number(process.env.BGM_VOLUME || 0.14);

const ffprobeDur = (f) => {
  try {
    return Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
};

// 单条旁白 → mp3；成功返回 { name, dur }，失败返回 null。
function tts(text, outPath) {
  const t = String(text || '').replace(/[#*【】\[\]]/g, '，').trim();
  if (t.length < 2) return null;
  try {
    cp.execFileSync('edge-tts', ['--voice', TTS_VOICE, '--rate', TTS_RATE, '--text', t.slice(0, 120), '--write-media', outPath],
      { timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
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
    const got = tts(text, path.join(adir, `vo${i}.mp3`));
    if (got) { sc.vo = text; sc.voFile = got.name; sc.voDur = got.dur; ok++; }
  });
  return ok;
}

const pickBgm = (seed = 0) => {
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
    const ms = Math.round(segs[i].start * 1000) + 250; // 留半拍呼吸感，别压着转场开口
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
      // 音乐被旁白闪避：旁白响时 BGM 自动压 8:1。
      filters.push(`[${bi}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${BGM_VOLUME},aformat=sample_rates=44100:channel_layouts=stereo[bg]`);
      filters.push(`[bg][narr]sidechaincompress=threshold=0.05:ratio=8:attack=40:release=600[duck]`);
      filters.push(`[duck][narr]amix=inputs=2:normalize=0[mix]`);
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

module.exports = { synthScenes, mixTrack, mux, pickBgm, ffprobeDur, tts };
