'use strict';
// hyperframes 项目生成 + 渲染。在 RENDER_TMP 下就地拼一个最小竖屏(1080x1920)项目，
// 渲染产物由调用方搬去正式目录。gsap 用 vendor 副本，不依赖渲染时网络。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { CFG } = require('./env');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 每个场景默认停留时长（秒）：50s ÷ ~10 镜 ≈ 5s，图片有足够时间被看清 + Ken Burns 缓推。
const SCENE_DUR = Number(process.env.SCENE_DUR || 5);
// 旁白后的“留白”：说完话后多停一秒，不让字卡接得太死。
const VO_TAIL = Number(process.env.VO_TAIL || 0.9);

// 时间轴规划（v11）：每镜时长 = max(LLM 给的 dur, 旁白时长+留白)，上限 12s。
// 目标时长 target 是“保底”而非硬截断：旁白多了成片自然变长（一般 50-70s）。
// 返回 { segs:[{start,dur}], total }；total 与 segs 同源，渲染/混音共用这一份。
function planTimeline(scenes, target) {
  const segs = [];
  let t = 0;
  for (const sc of scenes) {
    let want = Math.max(3, Math.min(8, Number(sc.dur) || SCENE_DUR));
    const need = (Number(sc.voDur) || 0) + VO_TAIL;
    if (need > want) want = Math.min(need, 12);
    segs.push({ start: +t.toFixed(2), dur: +want.toFixed(2) });
    t += want;
  }
  // 旁白很少、凑不够 target 时，把余量摊到最后一镜，保证成片≈目标时长。
  if (target - t > 1) segs[segs.length - 1].dur = +(segs[segs.length - 1].dur + (target - t)).toFixed(2);
  return { segs, total: +Math.max(target, t).toFixed(2) };
}

function writeProject(dir, { scenes, coverLocal, total, segs, ipName, tagline }) {
  if (!segs) ({ segs, total } = planTimeline(scenes, total));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.copyFileSync(CFG.gsapVendor, path.join(dir, 'assets', 'gsap.min.js'));
  fs.writeFileSync(path.join(dir, 'hyperframes.json'), JSON.stringify({
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { assets: 'assets' },
    media: { autoProxy: true },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'latiaomei-video', private: true }));

  const hasAsset = (f) => f && fs.existsSync(path.join(dir, 'assets', f));

  const clips = scenes.map((sc, i) => {
    const last = i === scenes.length - 1;
    const bg = hasAsset(sc.img);            // 联网搜到的图/视频，作全屏背景
    const media = bg ? (sc.video ? 'video' : 'image') : 'none';
    const bgTag = media === 'video'
      ? `<video class="sc-bg" src="assets/${esc(sc.img)}" muted playsinline autoplay="false" data-start="0" data-duration="${segs[i].dur}"></video>`
      : media === 'image'
        ? `<img class="sc-bg" src="assets/${esc(sc.img)}"/>`
        : `<div class="sc-bg sc-bg-empty"></div>`;
    return `
    <div class="clip scene ${last ? 'scene-cta' : ''} ${media === 'none' ? 'scene-plain' : ''}" data-start="${segs[i].start}" data-duration="${segs[i].dur}" id="sc${i}">
      <div class="sc-bgwrap">${bgTag}</div>
      <div class="sc-scrim"></div>
      <div class="sc-body">
        <div class="sc-kicker">${esc(sc.kicker || '')}</div>
        <div class="sc-title">${esc(sc.title || '')}</div>
        <div class="sc-sub">${esc(sc.sub || '')}</div>
      </div>
    </div>`;
  }).join('\n');

  // 时间轴：文本淡入淡出 + 背景图 Ken Burns 缓推缓移（无素材的场景跳过缩放）。
  const tl = scenes.map((sc, i) => {
    const { start, dur } = segs[i];
    const isLast = i === scenes.length - 1;
    const lines = [];
    lines.push(`tl.fromTo("#sc${i} .sc-body",{opacity:0,y:60},{opacity:1,y:0,duration:.5},${start})`);
    if (hasAsset(sc.img) && !sc.video) {
      // Ken Burns：整段缓慢放大并轻微平移，静止图也有“在动”的剪辑感。
      lines.push(`tl.fromTo("#sc${i} .sc-bg",{scale:1.06,x:0},{scale:1.18,x:-24,duration:${dur},ease:"none"},${start})`);
    }
    if (!isLast) {
      lines.push(`tl.to("#sc${i} .sc-body",{opacity:0,y:-40,duration:.4},${(start + dur - 0.4).toFixed(2)})`);
    }
    return lines.join('\n    ');
  }).join('\n    ');

  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh" data-resolution="portrait">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=1080, height=1920"/>
<script src="assets/gsap.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:#141210;font-family:"PingFang SC","Noto Sans CJK SC",ui-sans-serif,sans-serif}
#root{position:relative;width:100%;height:100%}
.scene{position:absolute;inset:0;overflow:hidden}
.sc-bgwrap{position:absolute;inset:0;overflow:hidden}
.sc-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center}
.sc-bg-empty{background:radial-gradient(120% 90% at 50% 20%,#241d16 0%,#141210 70%)}
.sc-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(20,18,16,.35) 0%,rgba(20,18,16,.15) 38%,rgba(20,18,16,.72) 74%,rgba(20,18,16,.92) 100%)}
.scene-plain .sc-scrim{background:radial-gradient(120% 90% at 50% 30%,rgba(36,29,22,.2) 0%,rgba(20,18,16,.6) 100%)}
.sc-body{position:absolute;left:0;right:0;bottom:0;padding:0 80px 200px;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;text-align:left}
.sc-kicker{color:#ffb4a6;font-size:40px;letter-spacing:.28em;margin-bottom:28px;font-weight:700;text-shadow:0 2px 16px rgba(0,0,0,.8)}
.sc-title{color:#fff;font-size:96px;font-weight:800;line-height:1.22;margin-bottom:32px;text-shadow:0 6px 28px rgba(0,0,0,.9)}
.sc-sub{color:#e7d4b4;font-size:46px;line-height:1.5;text-shadow:0 4px 20px rgba(0,0,0,.85)}
.scene-cta .sc-body{align-items:center;text-align:center;left:0;right:0}
.scene-cta .sc-title{color:#e0483a}
#watermark{position:absolute;right:48px;top:44px;z-index:5;color:rgba(246,234,214,.7);font-size:34px;letter-spacing:.1em;text-shadow:0 2px 12px rgba(0,0,0,.8)}
#tagbar{position:absolute;left:0;right:0;bottom:0;height:16px;z-index:5;background:linear-gradient(90deg,#e0483a,#b59a6e)}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1080" data-height="1920">
  <div id="watermark">${esc(ipName)}</div>
  ${clips}
  <div id="tagbar"></div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tl}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>`);
  return { segs, total };
}

// 下载素材图到项目 assets/，返回文件名；失败返回 null（视频降级为纯文字卡）。
async function fetchAsset(dir, url, name) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024 || buf.length > 20 * 1024 * 1024) return null;
    fs.writeFileSync(path.join(dir, 'assets', name), buf);
    return name;
  } catch { return null; }
}

function render(dir, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  cp.execFileSync('node', [CFG.hyperframesBin, 'render', '--output', outPath, '--quiet'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: CFG.tmpDir },
    maxBuffer: 32 * 1024 * 1024,
    // 50s 竖屏成片在 1.6G 共享机上单并发渲染约 7-8 分钟，留足余量。
    timeout: 18 * 60 * 1000,
  });
  return outPath;
}

module.exports = { writeProject, planTimeline, fetchAsset, render, esc };
