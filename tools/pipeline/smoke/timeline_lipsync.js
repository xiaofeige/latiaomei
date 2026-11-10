'use strict';
// 离线自测闸门（2026-10-06 复盘两条实盘病）：
//   A. 成片时长必须跟着内容走——旧版 planTimeline 把不足 target 的余量摊到最后一镜、
//      且 total=max(target,t)，结果每期都被硬凑成固定 50s；
//   B. 唇形必须跟配音同源——旧版把 edge-tts 的原 mp3 铺到 happyhorse 口播镜上，
//      但模型回来的片段自带音轨（起口晚 ~0.85s、中段漂移），嘴和声音必然错开。
// 本脚本不吃 LLM 配额，走真 edge-tts + 真 hyperframes 渲染 + 真 ffmpeg 混音，
// 并用互相关验“成片里听到的语音 = 片段里看到的嘴动的那条音轨”。
//
//   node tools/pipeline/smoke/timeline_lipsync.js            # 全跑（含一次渲染，约 1-3 分钟）
//   node tools/pipeline/smoke/timeline_lipsync.js --quick    # 只跑 A 的时间轴断言（秒级，不渲染）
//   node tools/pipeline/smoke/timeline_lipsync.js --hh <mp4> # 指定当口播镜素材的片段（默认复用归档片）
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const R = require('../lib/render');
const A = require('../lib/audio');
const { CFG } = require('../lib/env');

const QUICK = process.argv.includes('--quick');
const KEEP = process.env.SMOKE_KEEP === '1'; // 复用上轮渲染产物，调断言时不重渲染
const hhArg = (() => { const i = process.argv.indexOf('--hh'); return i > 0 ? process.argv[i + 1] : ''; })();
const HH_SRC = hhArg || path.join(CFG.uploadsDir, 'videos', 'lipsync-demo.mp4');

let fails = 0;
const ok = (name, cond, info = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------- A. 时间轴：时长跟内容走 ----------------
function testTimeline() {
  console.log('\n=== A. 成片时长跟着内容走（planTimeline）===');
  // 4 镜、每镜配音约 2-4s 的“短内容”：旧版会被补到 50s
  const scenes = [
    { vo: '各位吃货观众晚上好，我是辣条妹。', dur: 5 },
    { vo: '今日推荐干萝卜炒牛肚，嘎嘎香。', dur: 5 },
    { vo: '牛肚爽口，萝卜吸味。', dur: 5 },
    { vo: '这盘菜够我干六碗米饭！', dur: 5 },
  ];
  const dir = fs.mkdtempSync(path.join(CFG.tmpDir, 'smoke-tl-'));
  try {
    const n = A.synthScenes(dir, scenes);
    ok('edge-tts 旁白合成成功', n === scenes.length, `${n}/${scenes.length} 条`);
    const voSum = scenes.reduce((s, x) => s + (x.voDur || 0), 0);
    const { segs, total } = R.planTimeline(scenes, 50); // 故意传 50，看会不会被凑
    ok('不再硬凑目标时长（total≠50）', Math.abs(total - 50) > 2, `总旁白 ${voSum.toFixed(2)}s → 成片 ${total}s`);
    ok('成片=各镜之和（无补齐）', near(total, +segs.reduce((s, g) => s + g.dur, 0).toFixed(2), 0.05), `Σsegs=${segs.reduce((s, g) => s + g.dur, 0).toFixed(2)}`);
    ok('每镜槽位 ≥ 该镜配音长度（话不会说到一半切镜）',
      segs.every((g, i) => g.dur + 0.02 >= (scenes[i].voDur || 0)), segs.map((g, i) => `${g.dur}/${(scenes[i].voDur || 0).toFixed(2)}`).join(' '));
    ok('槽位首尾相接（下一镜不会压上一镜的话）', segs.every((g, i) => i === 0 || near(g.start, +(segs[i - 1].start + segs[i - 1].dur).toFixed(2), 0.02)));

    // happyhorse 镜：槽位必须等于片段实测时长（多一帧都是“人冻住话没完”）
    const mix = [{ vo: '开场。', voDur: 3, hhDur: 6.34, hh: true }, { vo: '收尾。', voDur: 2.5 }];
    const p2 = R.planTimeline(mix, 50);
    ok('hh 镜槽位=片段实长', near(p2.segs[0].dur, 6.34, 0.01), `segs[0]=${p2.segs[0].dur}`);
    ok('hh 镜不参与补齐', near(p2.total, +(6.34 + p2.segs[1].dur).toFixed(2), 0.05), `total=${p2.total}`);

    // 旧版两个病灶的回归哨兵：绝不允许出现固定 50.00
    ok('哨兵：总长不是整数 50.00（历史 bug 特征值）', Math.abs(total - 50) > 0.5 && Math.abs(p2.total - 50) > 0.5, `A=${total} B=${p2.total}`);
    return { dir, scenes, segs, total };
  } catch (e) {
    ok('A 段执行不抛错', false, e.message);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

// ---------------- B. 口播镜：唇形与配音同源 ----------------
// 用归档/指定的 happyhorse 片段当“口播镜画面”，走真实出片链路：
// useClipAudio → planTimeline(hhDur) → mixTrack → 渲染 → mux，
// 再用互相关问一句：成片里的语音，跟片段自带音轨是不是同一条（延迟≈0）？
function testLipSync() {
  console.log('\n=== B. 口播镜唇形/配音同源（happyhorse 片段）===');
  if (!fs.existsSync(HH_SRC)) { console.log('⏭️  跳过（没有可用口播镜片段：' + HH_SRC + '）'); return true; }
  const dir = KEEP ? path.join(CFG.tmpDir, 'smoke-ls') : fs.mkdtempSync(path.join(CFG.tmpDir, 'smoke-ls-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  try {
    const clip = 'hh0.mp4';
    fs.copyFileSync(HH_SRC, path.join(dir, 'assets', clip));
    const clipDur = A.ffprobeDur(path.join(dir, 'assets', clip));
    const sc = { vo: '（口播镜：配音改用片段自带音轨）', img: clip, video: true, hh: true, hhDur: clipDur, hh_prompt: '主播开口播报', title: '主播开麦', sub: '' };
    const ca = A.useClipAudio(dir, clip, 0);
    ok('片段自带音轨抽取成功（useClipAudio）', !!ca && !!ca.dur, ca ? `${ca.name} ${ca.dur.toFixed(2)}s（片段 ${clipDur.toFixed(2)}s）` : '返回 null');
    if (ca) { sc.voFile = ca.name; sc.voClip = ca.name; sc.voDur = ca.dur; }

    const { segs, total } = R.planTimeline([sc], 50);
    ok('口播镜槽位=片段实长', near(segs[0].dur, +clipDur.toFixed(2), 0.02), `槽位 ${segs[0].dur} / 片段 ${clipDur.toFixed(2)}`);

    const mix = A.mixTrack(dir, [sc], segs, total, { seed: 1 });
    ok('混音轨产出', !!mix, mix ? path.basename(mix) : 'null（降级无声版）');

    // 真渲染成片 + 混流（吃 CPU，约 1-2 分钟；SMOKE_KEEP=1 可复用上轮产物）
    const finalV = path.join(dir, 'final.mp4');
    if (KEEP && fs.existsSync(finalV) && A.ffprobeDur(finalV) > 1) {
      console.log(`    （复用已渲染 ${finalV}）`);
    } else {
      R.writeProject(dir, { scenes: [sc], segs, total, ipName: '自测', style: 'plain' });
      const out = path.join(dir, 'out.mp4');
      R.render(dir, out);
      let finalOut = out;
      const withA = path.join(dir, 'out-vo.mp4');
      if (mix && A.mux(out, mix, withA)) finalOut = withA;
      fs.copyFileSync(finalOut, finalV);
    }
    const finDur = A.ffprobeDur(finalV);
    ok('成片时长≈内容长度（不硬凑 50s）', near(finDur, total, 0.6), `成片 ${finDur.toFixed(2)}s / 时间轴 ${total}s`);

    // 核心验证：成片音轨 vs 片段自带音轨 的互相关延迟应≈0（|lag| ≤ 0.12s）
    const lag = crossCorrLag(finalV, path.join(dir, 'assets', clip), 4000);
    ok('成片语音与画面嘴动同源（|lag| ≤ 0.12s 且同源度 ≥ 0.6）',
      !!lag && Math.abs(lag.lag) <= 0.12 && lag.score >= 0.6,
      lag ? `lag=${(lag.lag * 1000).toFixed(0)}ms 同源度=${lag.score.toFixed(3)}` : '互相关失败');
    if (lag) console.log(`    （已取片段自带音轨：嘴动与声音出自同一次生成，天然对得上）`);

    // 对照：旧逻辑（直接铺 edge-tts 原 mp3）应被同一把尺子量出错位——证明闸门有牙
    const legacy = legacyMixLag(dir, segs, total, path.join(CFG.uploadsDir, 'tmptest', 'lipsync-vo.mp3'));
    if (legacy) {
      ok('旧逻辑对照被闸门抓出唇形错位（|lag| > 0.12s 或同源度 < 0.6）',
        Math.abs(legacy.lag) > 0.12 || legacy.score < 0.6,
        `铺原 mp3 时 lag=${(legacy.lag * 1000).toFixed(0)}ms 同源度=${legacy.score.toFixed(3)}`);
    }
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
    return fails === 0;
  } catch (e) {
    ok('B 段执行不抛错', false, e.message);
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
    return false;
  }
}

// 旧版对照：把归档的驱动 mp3 当作“本镜配音”混一次（重现旧逻辑），量它与画面嘴动音轨的错位
function legacyMixLag(dir, segs, total, voMp3) {
  if (!voMp3 || !fs.existsSync(voMp3)) return null;
  const d2 = fs.mkdtempSync(path.join(CFG.tmpDir, 'smoke-lg-'));
  try {
    fs.mkdirSync(path.join(d2, 'audio'), { recursive: true });
    fs.copyFileSync(voMp3, path.join(d2, 'audio', 'vo0.mp3'));
    // 旧代码的 lead 就是 0（hh+video），完全重现旧路径
    const sc = [{ voFile: 'vo0.mp3', voDur: A.ffprobeDur(path.join(d2, 'audio', 'vo0.mp3')), hh: true, video: true }];
    const mix = A.mixTrack(d2, sc, segs, total, { seed: 1 });
    return mix ? crossCorrLag(mix, path.join(dir, 'assets', 'hh0.mp4'), 4000) : null;
  } catch { return null; } finally {
    fs.rmSync(d2, { recursive: true, force: true });
  }
}

// 包络归一化互相关：返回 { lag(秒，正=b 比 a 晚), score(相关系数) }
function crossCorrLag(aFile, bFile, rate = 4000) {
  const a = pcm(aFile, rate), b = pcm(bFile, rate);
  if (!a || !b) return null;
  const envA = centered(envelope(a, rate)), envB = centered(envelope(b, rate));
  const nA = norm(envA), nB = norm(envB);
  const maxLag = Math.min(3 * 50, envA.length, envB.length); // ±3s，步长 20ms
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, cnt = 0;
    for (let i = 0; i < nB.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < nA.length) { s += nA[j] * nB[i]; cnt++; }
    }
    // 两条包络都是单位向量：重叠区内积满分 1.0（同一源），不相关则接 0。
    if (cnt > 50 && s > best.score) best = { lag: lag / 50, score: +s.toFixed(4) };
  }
  return best;
}
function pcm(file, rate) {
  try {
    const buf = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
      { maxBuffer: 64 * 1024 * 1024 });
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1));
    return new Int16Array(ab);
  } catch { return null; }
}
// 20ms 窗能量包络（对响度重采样/轻度压缩鲁棒）
function envelope(x, rate) {
  const win = Math.floor(rate * 0.02);
  const out = [];
  for (let s = 0; s + win <= x.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += x[i] * x[i];
    out.push(Math.sqrt(e / win) / 32768);
  }
  return out;
}
function centered(v) {
  const m = v.reduce((s, x) => s + x, 0) / (v.length || 1);
  return v.map((x) => x - m);
}
function norm(v) {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

console.log(`自测环境：edge-tts=${cp.execSync('which edge-tts').toString().trim()} | ffmpeg=${cp.execSync('which ffmpeg').toString().trim()}`);
console.log(`口播镜素材：${HH_SRC}\n`);
const a = testTimeline();
if (a) fs.rmSync(a.dir, { recursive: true, force: true });
if (!QUICK) testLipSync();
console.log(fails ? `\n❌ 自测未通过：${fails} 项失败` : '\n✅ 自测全部通过');
process.exit(fails ? 1 : 0);
