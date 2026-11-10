'use strict';
// hyperframes 项目生成 + 渲染。在 RENDER_TMP 下就地拼一个最小竖屏(1080x1920)项目，
// 渲染产物由调用方搬去正式目录。gsap 用 vendor 副本，不依赖渲染时网络。
// 风格（STYLE.md）：默认 style='news'——《辣妹快报》新闻联播式版式：
//   主体=主播画面（hh 动态片段或定妆立绘 anchorPath），右上角「本期美食」窗口（sc.food），
//   下三分之一新闻字幕条，底部快讯滚动条。style='plain' 回退旧图文卡。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { CFG } = require('./env');

const ffprobeDur = (f) => {
  try {
    return Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 没有旁白的镜头（纯画面/空镜）默认停留时长（秒），给 Ken Burns 一点时间。
const SCENE_DUR = Number(process.env.SCENE_DUR || 3.5);
// 镜头下限/上限：内容决定时长，但单镜不短于 2.5s（字还没看清就切）不长于 15s（口播镜配音上限）。
const SCENE_MIN = Number(process.env.SCENE_MIN || 2.5);
const SCENE_MAX = Number(process.env.SCENE_MAX || 15);
// 旁白后的“留白”：说完话后多停一会儿，不让字卡接得太死。
const VO_TAIL = Number(process.env.VO_TAIL || 0.9);

// 时间轴规划（v14 修订：成片时长完全跟着内容走）。
// 每镜槽位：
//   · happyhorse 片段镜 → 片段实测时长（画面几秒就几秒，多给一帧都会「人冻住话没完」）；
//   · 有旁白镜 → 实测语音时长 + VO_TAIL（念多久停多久）；
//   · 无旁白镜 → LLM 给的 dur（兜底 SCENE_DUR），只作画面停留参考。
// ⚠️ 历史坑（2026-10-06 复盘，两条都别再引回来）：
//   1) 旧版把不足 target 的余量全摊到最后一镜、且 total=max(target,t)，导致每期成片
//      不管内容多少都硬凑成固定 50s（末尾一镜干瞪 + 尾段没口型）；
//   2) 旧版给 hh 说话镜的槽位用 LLM 猜的 dur（5s）而配音 6-7s，声音漫过下一镜，
//      下一镜是闭嘴立绘却在讲话 → 唇形和台词对不上。
// target 参数保留只为兼容旧调用，**不再参与补齐**；传 0/不传即可。
// 返回 { segs:[{start,dur}], total }；total 与 segs 同源，渲染/混音共用这一份。
function planTimeline(scenes, target = 0) {
  const segs = [];
  let t = 0;
  for (const sc of scenes) {
    const clipDur = Number(sc.hhDur) || 0;
    // happyhorse 镜头：槽位=片段实测时长，片段放完立刻切镜，不会出现
    // 「人冻住但配音还在念」的口型错位（2026-10-06 复盘）。
    if (clipDur > 0) {
      segs.push({ start: +t.toFixed(2), dur: +clipDur.toFixed(2) });
      t += clipDur;
      continue;
    }
    const vo = Number(sc.voDur) || 0;
    let want = vo > 0
      ? Math.min(SCENE_MAX, Math.max(SCENE_MIN, vo + VO_TAIL))
      : Math.min(SCENE_MAX, Math.max(SCENE_MIN, Number(sc.dur) || SCENE_DUR));
    // 说话镜（hh 音频驱动但片段没拿到，退图卡）配音可能长达 15s，别被 SCENE_MIN 压短。
    if (vo > 0 && want < vo + 0.3) want = Math.min(SCENE_MAX, vo + 0.3);
    segs.push({ start: +t.toFixed(2), dur: +want.toFixed(2) });
    t += want;
  }
  // 时长 = 各镜之和，不做任何“凑整/保底”：内容多短就多短，绝不硬撑到目标秒数。
  return { segs, total: +t.toFixed(2) };
}

// 把多段人物片段按顺序拼成一条连续轨道（host 模式用）：成片里只放一个 <video>，
// 1.6G 内存的机器同时解码 7 段视频会直接把 Chrome 打死（实盘 render_cancelled_parent_exited）。
// 先试 -c copy（各段都是 normalizeClip 统一参数编码过的，理论上可直接串），时长对不上再重编码。
function concatVideos(dir, files, outName) {
  const list = path.join(dir, 'concat.txt');
  fs.writeFileSync(list, files.map((f) => `file 'assets/${f}'`).join('\n'));
  const out = path.join(dir, 'assets', outName);
  const tryCmd = (args) => {
    try {
      cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out],
        { cwd: dir, timeout: 12 * 60_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
      return fs.existsSync(out) && fs.statSync(out).size > 10_000;
    } catch { return false; }
  };
  let okCopy = tryCmd(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-fflags', '+genpts']);
  const want = files.reduce((s, f) => s + (Number(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path.join(dir, 'assets', f)], { encoding: 'utf8' }).trim()) || 0), 0);
  if (okCopy && Math.abs(ffprobeDur(out) - want) > 0.25) okCopy = false; // 串歪了，重编码
  if (!okCopy) {
    // 重编码串联：统一 1080x1920@30、yuv420p、加静音轨（画面轨道不用它的声音，配音走 mixTrack）
    if (!tryCmd(['-f', 'concat', '-safe', '0', '-i', 'concat.txt',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-af', 'apad', '-c:a', 'aac', '-b:a', '64k'])) {
      fs.rmSync(out, { force: true });
      return '';
    }
  }
  fs.rmSync(list, { force: true });
  return outName;
}

// 静帧片段：某镜没拿到动态片段时，用立绘/美食图撑一个与槽位等长（按整帧数）的片段，
// 保证主播轨道连续、时间轴不漂移，而且永远不会出现黑屏底。
function stillSegment(dir, imgFile, dur, outName) {
  const src = path.join(dir, 'assets', imgFile);
  if (!imgFile || !fs.existsSync(src)) return '';
  const frames = Math.max(2, Math.round(dur * 30)); // 按帧数定长，避免 -t 取整造成轨道与字幕漂移
  const out = path.join(dir, 'assets', outName);
  try {
    cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', `assets/${imgFile}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-r', '30', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-shortest', '-c:a', 'aac', '-b:a', '64k', out],
      { cwd: dir, timeout: 5 * 60_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return fs.existsSync(out) && fs.statSync(out).size > 5_000 ? outName : '';
  } catch { return ''; }
}

function writeProject(dir, { scenes, coverLocal, total, segs, ipName, tagline, style, anchorPath, ticker, hostTrack }) {
  if (!segs) ({ segs, total } = planTimeline(scenes, total));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.copyFileSync(CFG.gsapVendor, path.join(dir, 'assets', 'gsap.min.js'));

  // 新闻风格：有主播立绘就复制进 assets 做静态镜头的主播背景。
  // news 与 host（全程主播口播）共用《辣妹快报》新闻版式；只有显式 plain 才回退旧图文卡。
  const news = String(style || CFG.videoStyle || 'news') !== 'plain';
  let anchorFile = '';
  if (news && anchorPath && fs.existsSync(anchorPath)) {
    anchorFile = 'anchor.jpg';
    fs.copyFileSync(anchorPath, path.join(dir, 'assets', anchorFile));
  }

  fs.writeFileSync(path.join(dir, 'hyperframes.json'), JSON.stringify({
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { assets: 'assets' },
    media: { autoProxy: true },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'latiaomei-video', private: true }));

  const hasAsset = (f) => f && fs.existsSync(path.join(dir, 'assets', f));

  const host = hostTrack && hasAsset(hostTrack) ? hostTrack : '';
  const clips = scenes.map((sc, i) => {
    const last = i === scenes.length - 1;
    const bg = hasAsset(sc.img);            // 联网搜到的图/视频，作全屏背景
    const media = bg ? (sc.video ? 'video' : 'image') : 'none';
    let bgTag = media === 'video'
      ? `<video class="sc-bg" src="assets/${esc(sc.img)}" muted playsinline autoplay="false" data-start="0" data-duration="${segs[i].dur}"></video>`
      : media === 'image'
        ? `<img class="sc-bg" src="assets/${esc(sc.img)}"/>`
        : `<div class="sc-bg sc-bg-empty"></div>`;
    // 全程主播口播：画面由底层一条连续主播轨道负责，场景层只叠字幕条/美食窗（不再每镜一个 <video>）。
    if (host) bgTag = '';
    // 新闻版式：hh 主播动态片段照旧全屏；其余静态镜头背景换成主播立绘，美食图进右上窗口。
    else if (news && !sc.video && anchorFile) bgTag = `<img class="sc-bg" src="assets/${anchorFile}"/>`;
    // 实盘黑屏兜底（2026-10-06）：立绘缺失/片段废掉时，绝不留纯黑底——拿本镜美食图当背景。
    else if (news && !sc.video && !anchorFile && hasAsset(sc.food || sc.img)) {
      bgTag = `<img class="sc-bg" src="assets/${esc(sc.food || sc.img)}"/>`;
    }
    // 右上角「本期美食」窗口：优先本镜指派的美食素材（food），没指派但本镜本身就是美食图卡也进窗口。
    const pipSrc = sc.food && hasAsset(sc.food) ? sc.food : (!sc.video && bg ? sc.img : '');
    const pipHtml = news && pipSrc ? `
      <div class="sc-pip"><div class="pip-frame">
        <img class="pip-img" src="assets/${esc(pipSrc)}"/>
        <div class="pip-tag">本期美食</div>
        <div class="pip-cap">${esc(sc.kicker || '')}</div>
      </div></div>` : '';
    // 新闻字幕条（下三分之一）；CTA 收尾镜沿用居中大字。
    const copyHtml = news && !last ? `
      <div class="sc-l3">
        <div class="l3-kicker">${esc(sc.kicker || '')}</div>
        <div class="l3-title">${esc(sc.title || '')}</div>
        <div class="l3-sub">${esc(sc.sub || '')}</div>
      </div>` : `
      <div class="sc-body">
        <div class="sc-kicker">${esc(sc.kicker || '')}</div>
        <div class="sc-title">${esc(sc.title || '')}</div>
        <div class="sc-sub">${esc(sc.sub || '')}</div>
      </div>`;
    return `
    <div class="clip scene ${news ? 'news' : ''} ${last ? 'scene-cta' : ''} ${!host && media === 'none' && !(news && anchorFile) ? 'scene-plain' : ''}" data-start="${segs[i].start}" data-duration="${segs[i].dur}" id="sc${i}">
      <div class="sc-bgwrap">${bgTag}</div>
      <div class="sc-scrim"></div>
      ${pipHtml}
      ${copyHtml}
    </div>`;
  }).join('\n');

  // 时间轴：文本淡入淡出 + 背景图 Ken Burns 缓推缓移（无素材的场景跳过缩放）。
  const tl = scenes.map((sc, i) => {
    const { start, dur } = segs[i];
    const isLast = i === scenes.length - 1;
    const lines = [];
    lines.push(`tl.fromTo("#sc${i} .sc-body,#sc${i} .sc-l3",{opacity:0,y:60},{opacity:1,y:0,duration:.5},${start})`);
    if (hasAsset(sc.img) && !sc.video) {
      // Ken Burns：整段缓慢放大并轻微平移，静止图也有“在动”的剪辑感。
      lines.push(`tl.fromTo("#sc${i} .sc-bg",{scale:1.06,x:0},{scale:1.18,x:-24,duration:${dur},ease:"none"},${start})`);
    } else if (news && !sc.video && anchorFile) {
      // 主播立绘背景：只极缓推近，不抢戏。
      lines.push(`tl.fromTo("#sc${i} .sc-bg",{scale:1.02},{scale:1.06,duration:${dur},ease:"none"},${start})`);
    }
    if (host) {
      // 底层主播轨道整段极缓推近，避免“看着像静止立绘”
      lines.push(`tl.fromTo("#hosttrack",{scale:1.0},{scale:1.04,duration:${total},ease:"none"},0)`);
    }
    if (news) {
      const pipSrc = sc.food || (!sc.video && hasAsset(sc.img) ? sc.img : '');
      if (pipSrc) lines.push(`tl.fromTo("#sc${i} .pip-img",{scale:1.05},{scale:1.16,duration:${dur},ease:"none"},${start})`);
      // 快讯滚动：每镜从头滚一遍，速度跟镜头时长走。
      lines.push(`tl.fromTo("#tickTxt",{x:1080},{x:-2400,duration:${dur},ease:"none"},${start})`);
    }
    if (!isLast) {
      lines.push(`tl.to("#sc${i} .sc-body,#sc${i} .sc-l3",{opacity:0,y:-40,duration:.4},${(start + dur - 0.4).toFixed(2)})`);
    }
    return lines.join('\n    ');
  }).join('\n    ');

  const headHtml = news ? `
  <div id="news-head"><div id="news-logo">辣妹快报</div><div id="news-sub">${esc(ipName)} · 美食联播</div></div>` : '';
  const watermarkHtml = news ? '' : `<div id="watermark">${esc(ipName)}</div>`;
  const tickerText = [ticker, tagline, ipName].filter(Boolean).join('　　').slice(0, 120) || '辣妹快报 · 本期美食联播';
  const tickerHtml = news ? `
  <div id="ticker"><div class="tick-label">快讯</div><div id="tickwrap"><div id="tickTxt">${esc(tickerText)}</div></div></div>` : `
  <div id="tagbar"></div>`;

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
.host-track{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
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
/* ---- 新闻风格（《辣妹快报》）---- */
.news .sc-scrim{background:linear-gradient(180deg,rgba(20,18,16,.28) 0%,rgba(20,18,16,.04) 42%,rgba(20,18,16,.6) 78%,rgba(20,18,16,.88) 100%)}
.news.scene-cta .sc-body{padding-bottom:320px}
#news-head{position:absolute;left:48px;top:44px;z-index:7;display:flex;align-items:center;gap:20px}
#news-logo{background:linear-gradient(135deg,#c8161d,#e0483a);color:#fff;font-weight:800;font-size:40px;letter-spacing:.1em;padding:14px 26px;border-radius:12px;box-shadow:0 8px 26px rgba(200,22,29,.45)}
#news-sub{color:rgba(246,234,214,.9);font-size:30px;letter-spacing:.14em;text-shadow:0 2px 12px rgba(0,0,0,.85)}
.sc-pip{position:absolute;right:44px;top:180px;z-index:6;width:440px}
.pip-frame{position:relative;width:100%;height:330px;overflow:hidden;border:6px solid #b59a6e;border-radius:14px;background:#000;box-shadow:0 12px 36px rgba(0,0,0,.6)}
.pip-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center}
.pip-tag{position:absolute;left:0;top:0;z-index:2;background:#c8161d;color:#fff;font-size:26px;font-weight:700;letter-spacing:.16em;padding:10px 18px;border-bottom-right-radius:14px}
.pip-cap{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:36px 18px 12px;font-size:28px;color:#fff;letter-spacing:.08em;background:linear-gradient(180deg,transparent,rgba(0,0,0,.78))}
.sc-l3{position:absolute;left:0;right:0;bottom:150px;z-index:6;padding:40px 90px 44px 50px;border-left:16px solid #c8161d;background:linear-gradient(90deg,rgba(160,20,26,.94) 0%,rgba(60,18,16,.82) 46%,rgba(20,18,16,.42) 82%,rgba(20,18,16,.12) 100%);clip-path:polygon(0 0,100% 0,94% 100%,0 100%)}
.l3-kicker{color:#ffd9a0;font-size:34px;letter-spacing:.3em;font-weight:700;margin-bottom:14px}
.l3-title{color:#fff;font-size:78px;font-weight:800;line-height:1.2;margin-bottom:16px;text-shadow:0 4px 22px rgba(0,0,0,.7)}
.l3-sub{color:#f0ddc0;font-size:40px;line-height:1.45;text-shadow:0 3px 16px rgba(0,0,0,.7)}
#ticker{position:absolute;left:0;right:0;bottom:0;height:96px;z-index:8;display:flex;align-items:stretch;background:rgba(10,9,8,.92);border-top:4px solid #c8161d;overflow:hidden}
.tick-label{flex:0 0 auto;display:flex;align-items:center;background:#c8161d;color:#fff;font-size:34px;font-weight:700;letter-spacing:.2em;padding:0 28px}
#tickwrap{position:relative;flex:1;overflow:hidden}
#tickTxt{position:absolute;left:0;top:50%;margin-top:-22px;white-space:nowrap;color:#f6ead6;font-size:38px;letter-spacing:.06em}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1080" data-height="1920">
  ${host ? `<video class="clip host-track" src="assets/${esc(host)}" muted playsinline data-start="0" data-duration="${total}" id="hosttrack"></video>` : ''}
  ${headHtml}
  ${watermarkHtml}
  ${clips}
  ${tickerHtml}
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

// 渲染前体检（2026-10-06 实盘）：/tmp 被历史遗留文件塞满后，hyperframes 会直接拒绝渲染，
// 但它只吐一句含糊的 render_cancelled_parent_exited，排查半天。这里先自己看清盘 + 清自家缓存。
function freeMb(mp) {
  try {
    return Math.floor(Number(cp.execFileSync('df', ['-Pm', mp], { encoding: 'utf8' })
      .split('\n')[1].split(/\s+/)[3]) || 0);
  } catch { return 999999; }
}
function pruneStale(root, maxAgeMs) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch { /* 跳过 */ }
    }
  } catch { /* 目录不存在 */ }
  return n;
}
function render(dir, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const MIN_MB = 300;
  let tmpFree = freeMb('/tmp'), dataFree = freeMb(CFG.tmpDir);
  if (tmpFree < MIN_MB || dataFree < MIN_MB) {
    const a = pruneStale(path.join(CFG.tmpDir, 'hyperframes-extract-cache-0'), 6 * 3600_000);
    const b = pruneStale(path.join(CFG.uploadsDir, 'vo-tmp'), 24 * 3600_000);
    console.warn(`[render] 空闲不足（/tmp ${tmpFree}MB / ${CFG.tmpDir} ${dataFree}MB），先清自家缓存：抽帧缓存 ${a} 项、临时配音 ${b} 项`);
    tmpFree = freeMb('/tmp'); dataFree = freeMb(CFG.tmpDir);
  }
  if (tmpFree < MIN_MB) {
    throw new Error(`渲染前体检不通过：/tmp 只剩 ${tmpFree}MB（hyperframes 要求 ≥${MIN_MB}MB 临时空间）。`
      + `请清理 /tmp（历史遗留的大文件常堆在里头），或把 TMPDIR 指到大分区后重跑。`);
  }
  if (dataFree < MIN_MB) throw new Error(`渲染前体检不通过：RENDER_TMP(${CFG.tmpDir}) 只剩 ${dataFree}MB，请清理。`);
  cp.execFileSync('node', [CFG.hyperframesBin, 'render', '--output', outPath, '--quiet'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: CFG.tmpDir },
    maxBuffer: 32 * 1024 * 1024,
    // 50s 竖屏成片在 1.6G 共享机上单并发渲染约 7-8 分钟，留足余量。
    timeout: 18 * 60 * 1000,
  });
  return outPath;
}

module.exports = { writeProject, planTimeline, fetchAsset, render, concatVideos, stillSegment, esc };
