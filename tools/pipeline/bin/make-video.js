#!/usr/bin/env node
'use strict';
// 手动出片脚本（2026-10-05 定稿）：视频生产不走 worker 自动执行，由辣条妹在本机手动跑。
// 复用流水线同一套代码（jobs/project_step.js 的 分镜/成片/平台文案），只是入口换成 CLI。
//
// 用法（在 tools/pipeline 下）：
//   node bin/make-video.js --project 3                  # 新出分镜 → 渲染成片 → 自动挂抖音待审稿（后台可见）
//   node bin/make-video.js --project 3 --no-submit      # 只落盘不挂稿（本地试渲染用，后台看不到）
//   node bin/make-video.js --project 3 --reuse          # 用服务端最近一条已完成的分镜
//   node bin/make-video.js --project 3 --storyboard-step 5
//   node bin/make-video.js --project 3 --storyboard /path/to/sb.json   # 用本地分镜文件（可手改后回传）
//   node bin/make-video.js --project 3 --attach /path/to/xx.mp4        # 不出片，只把已出成片挂进「待放行」
//     （专治“片子在磁盘上但后台没”：历史手动出的片可以用这个补登记）
//   node bin/make-video.js --project 3 --copy           # 顺带产四平台文案稿（落待审，放行权在人）
// 常用开关：--prompt "本轮指令"  --hh 0|1  --renderer hyperframes|openmontage
//           --secs 50  --style news|plain  --label s5（产物文件名后缀）  --copy（顺带产四平台文案）
//           --note "挂稿备注" --platform douyin
// 产物：data/uploads/videos/proj-<id>-<label>-<ts>.mp4（+ 同名 -timeline.json 时间轴 sidecar）
//       + 分镜快照 data/uploads/storyboards/…json；缺省还挂一条抖音待审稿进后台「待放行」（放行权在人）。
const fs = require('fs');
const path = require('path');
const { CFG } = require('../lib/env');
const api = require('../lib/api');
const ps = require('../jobs/project_step');

function parseArgs(argv) {
  const a = { hh: undefined, submit: true, copy: false, reuse: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--project': a.project = Number(next()); break;
      case '--prompt': a.prompt = next(); break;
      case '--storyboard': a.storyboard = next(); break;
      case '--storyboard-step': a.storyboardStep = Number(next()); break;
      case '--reuse': a.reuse = true; break;
      case '--renderer': a.renderer = next(); break;
      case '--style': a.style = next(); break;
      case '--hh': a.hh = String(next()); break;
      case '--secs': a.secs = Number(next()); break;
      case '--label': a.label = next(); break;
      case '--submit': a.submit = true; break;
      case '--no-submit': a.submit = false; break;
      case '--copy': a.copy = true; break;
      case '--attach': a.attach = next(); break;
      case '--platform': a.platform = next(); break;
      case '--note': a.note = next(); break;
      default: console.error('未知参数：' + k); process.exit(2);
    }
  }
  if (!a.project) {
    console.error('用法：node bin/make-video.js --project <id> [选项]（--help 见文件头注释）');
    process.exit(2);
  }
  return a;
}

const log = (...xs) => console.log('[make-video]', ...xs);

// 把已渲染好的成片挂成待审稿（不重渲染、不烧模型配额）。
// 备注/话题标签优先从成片旁边的 -timeline.json 与项目最新分镜快照里拿。
async function attachFilm(a, project, assets) {
  const file = fs.existsSync(a.attach) ? a.attach : path.join(CFG.uploadsDir, 'videos', path.basename(a.attach));
  if (!fs.existsSync(file)) throw new Error('成片文件不存在：' + a.attach);
  const videoUrl = '/uploads/videos/' + path.basename(file);
  const side = file.replace(/\.mp4$/, '-timeline.json');
  let tl = null;
  try { if (fs.existsSync(side)) tl = JSON.parse(fs.readFileSync(side, 'utf8')); } catch { /* 手改坏了当没 sidecar */ }
  // 发布文案：找分镜快照（--storyboard 指定 > uploads/storyboards 里本项目最新一份）
  let sb = null;
  const sbDir = path.join(CFG.uploadsDir, 'storyboards');
  const cand = a.storyboard ? [a.storyboard]
    : (fs.existsSync(sbDir) ? fs.readdirSync(sbDir).filter((f) => f.startsWith(`proj-${project.id}-`)).sort().reverse().map((f) => path.join(sbDir, f)) : []);
  for (const c of cand) { try { if (fs.existsSync(c)) { sb = JSON.parse(fs.readFileSync(c, 'utf8')); break; } } catch { /* 跳过 */ } }
  const note = a.note || `项目#${project.id} 手动出片登记（${tl ? `${tl.total_secs}s / ${tl.timeline.length} 镜` : '时长未记'}${tl && tl.hh_shots ? `，happyhorse ${tl.hh_shots} 镜` : ''}）`;
  const id = await api.createSocialItem({
    gen_task_id: 0, review_id: 0, platform: a.platform || 'douyin',
    title: String(project.title || '项目成片').slice(0, 40),
    body: String((sb && sb.caption) || project.brief || '').slice(0, 500),
    tags: ((sb && sb.hashtags) || []).map(String),
    images: (assets || []).filter((x) => x.kind !== 'file').map((x) => x.path),
    video: videoUrl, note,
  });
  log(`已挂待审稿 #${id.id}（${a.platform || 'douyin'}）：${videoUrl}`);
  log('后台看片放行：https://latiaomei.infinityfly.xin/latiaomei/ →「待放行」；旧片不满意可直接驳回。');
  return id;
}

async function main() {
  const a = parseArgs(process.argv);
  const { project, assets, steps, char_refs, site } = await api.getProject(a.project);
  if (!project) throw new Error(`项目 #${a.project} 不存在`);
  log(`项目 #${project.id}《${project.title}》素材 ${assets.length} 项，历史步骤 ${steps.length} 条`);

  // ---- 0) --attach：不出片，只把磁盘上已有的成片挂进待放行（CLI 缺省 submit=false，后台看不到）
  if (a.attach) {
    const id = await attachFilm(a, project, assets);
    console.log(`\n登记完成：item #${id.id}`);
    return;
  }

  // ---- 1) 分镜：本地文件 > 指定步骤 > 复用最近 done > 新出 ----
  let script = null;
  let workSteps = (steps || []).slice(); // doVideo 从 steps 里挑 storyboard
  if (a.storyboard) {
    script = JSON.parse(fs.readFileSync(a.storyboard, 'utf8'));
    workSteps.unshift({ id: 0, kind: 'storyboard', status: 'done', result: JSON.stringify(script) });
    log(`用本地分镜 ${a.storyboard}（${script.scenes.length} 镜）`);
  } else if (a.storyboardStep || a.reuse) {
    const pick = a.storyboardStep
      ? workSteps.find((s) => s.id === a.storyboardStep)
      : workSteps.find((s) => s.kind === 'storyboard' && s.status === 'done' && s.result);
    if (!pick) throw new Error('指定的分镜步骤不存在或还没跑完');
    log(`复用服务端分镜步骤 #${pick.id}`);
  } else {
    log('调 LLM 出新分镜……');
    const out = await ps.doStoryboard({ id: 0, payload: { prompt: a.prompt || '', style: a.style } }, { project, assets, char_refs });
    script = out.result;
    const dir = path.join(CFG.uploadsDir, 'storyboards');
    fs.mkdirSync(dir, { recursive: true });
    const snap = path.join(dir, `proj-${project.id}-${new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '')}.json`);
    fs.writeFileSync(snap, JSON.stringify(script, null, 2));
    log(`分镜已出（${script.scenes.length} 镜），快照：${snap}`);
    log('想手改：改完快照文件后用 --storyboard 该文件 再来出片');
    workSteps.unshift({ id: 0, kind: 'storyboard', status: 'done', result: JSON.stringify(script) });
  }

  // ---- 2) 成片 ----
  const dir = fs.mkdtempSync(path.join(CFG.tmpDir, `manual-p${project.id}-`));
  const p = {
    project_id: project.id, step_id: 0, kind: 'video',
    renderer: a.renderer || project.renderer || 'hyperframes',
    style: a.style || CFG.videoStyle || 'news',
    submit: a.submit,
  };
  if (a.hh !== undefined) p.hh = a.hh;
  if (a.secs) p.secs = a.secs;
  if (a.storyboardStep) p.storyboard_step_id = a.storyboardStep;
  const step = { id: (a.label ? String(a.label).replace(/^s+/, '') : 0) }; // 产物名已是 -s<id>，label 别再带 s 前缀
  try {
    log('开始渲染成片（含 happyhorse 人物镜头时会比较久，别关终端）……');
    const t0 = Date.now();
    const out = await ps.doVideo({ id: 0, payload: p }, { project, assets, steps: workSteps, char_refs, site, step, p, dir });
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    log(`成片步骤：${out.status}（${mins} 分钟）—— ${out.note || ''}`);
    if (out.result && out.result.video) {
      log('相对 URL：' + out.result.video);
      log('本地文件：' + path.join(CFG.uploadsDir, out.result.video.replace('/uploads/', '')));
    }
    if (out.status !== 'done') process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3) 可选：四平台文案 ----
  if (a.copy) {
    log('产四平台文案稿（落待审，放行权在人）……');
    try {
      const out = await ps.doCopy({ id: 0, payload: { prompt: a.prompt || '' } }, { project, steps: workSteps, site, p: {} });
      log('文案步骤：' + out.note);
    } catch (e) {
      log('文案失败：' + e.message);
      process.exitCode = 1;
    }
  }
  log('完成。审片：https://latiaomei.infinityfly.xin/latiaomei/ 「待放行」；不满意改提示词再跑一轮。');
}

main().catch((e) => { console.error('[make-video] 失败：', e.message); process.exit(1); });
