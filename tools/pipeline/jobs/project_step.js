'use strict';
// project_step（v13 项目制内容生产）：一条 step = 一次交互，跑完回填结果，
// 辣条妹在工作区看效果、改提示词/素材/分镜，再跑下一轮。三种步骤：
//   storyboard  制片提示词 + 素材描述 + 主角定妆图 → LLM 出分镜 JSON（人可手改）
//   video       按（可能被人改过的）分镜渲染成片：人物动态镜头交 happyhorse 生成，
//               其余镜头 hyperframes 图卡；产物挂 douyin 待审稿
//   copy        按项目主题产四平台文案 → social_items 待审
// 铁律不变：本 job 零发布动作，放行权在辣条妹；happyhorse 不可用自动退回纯图卡。
const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { chat } = require('../lib/llm');
const R = require('../lib/render');
const media = require('../lib/media');
const A = require('../lib/audio');
const vision = require('../lib/vision');
const social = require('../lib/social');
const pub = require('../lib/publishers');
const hh = require('../lib/happyhorse');
const OM = require('../lib/openmontage');
const { CFG } = require('../lib/env');

const TARGET_SECS = Number(process.env.VIDEO_TARGET_SECS || 50);

// 主角设定（v13）：视频里出现的人物主角统一是"辣条妹"3D 形象，
// 定妆参考图（三视图/特写）由服务端 settings 下发，happyhorse 镜头拿它保人物一致性。
const CHAR_BRIEF = `主角设定（全片人物镜头统一用这一形象，不得改设定）：
辣条妹——3D 卡通写实风少女，红棕色双丸子头（黄色发圈），圆框黑眼镜，
白色连帽卫衣 + 橙色围裙（胸前黄色"辣"字牌），深蓝牛仔裤，白鞋，常手持不锈钢锅铲。
参考图：三视图（正/侧/背）与脸部特写；happyhorse i2v 镜头以定妆特写（或本镜指派的项目实拍图）
做首帧，形象从首帧就锁死，hh_prompt 只写动作与镜头运动。`;

const SB_PERSONA = `你是短视频编导，口吻口语化、有钩子，不写营销号腔、不堆形容词、不用绝对化用语（广告法）。
铁律：只能基于给定的制片提示词与素材描述进行创作，严禁编造没出现的人物、动作、食物、场景；
旁白（vo）必须与画面文案（title/sub）说的是同一件事，连起来是一个完整故事。`;

// 素材路径（/uploads/...）转本机可读 URL：Go 服务与 worker 同机，走回环最快。
const abs = (u) => (u && u.startsWith('/') ? CFG.apiBase + u : u);

async function run(task) {
  const p = task.payload || {};
  const projectId = Number(p.project_id) || 0;
  const stepId = Number(p.step_id) || 0;
  if (!projectId || !stepId) return { status: 'skipped', note: 'payload 缺 project_id/step_id' };
  const { project, assets, steps, char_refs, site } = await api.getProject(projectId);
  const step = (steps || []).find((s) => s.id === stepId);
  if (!step) return { status: 'skipped', note: `步骤 #${stepId} 不存在` };

  const dir = path.join(CFG.tmpDir, `job-ps${stepId}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    let out;
    if (step.kind === 'storyboard') out = await doStoryboard(task, { project, assets, char_refs });
    else if (step.kind === 'video') out = await doVideo(task, { project, assets, steps, char_refs, site, step, p, dir });
    else if (step.kind === 'copy') out = await doCopy(task, { project, steps, site, p });
    else out = { status: 'skipped', note: '未知步骤类型 ' + step.kind, result: {} };
    await api.finishProjectStep(stepId, out.status, JSON.stringify(out.result ?? {}), '', out.note || '').catch((e) => console.error('[project_step] 回填步骤失败:', e.message));
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 素材理解：项目素材 + 主角定妆图，逐张"看过"再交给分镜 LLM ----------
async function understandAssets(dir, assets, prompt) {
  const list = [];
  for (let i = 0; i < (assets || []).length; i++) {
    const a = (assets || [])[i];
    if (a.kind === 'file') continue; // 非图片素材不进画面轮转
    const got = await media.download(dir, abs(a.path), `a${list.length + 1}`, { kind: 'image' });
    if (!got) continue;
    const item = { no: list.length + 1, name: got.name, path: a.path };
    if (vision.available()) {
      item.desc = await vision.describe(path.join(dir, 'assets', got.name), prompt.slice(0, 120))
        || a.note || '（描述失败，内容未知）';
    } else {
      item.desc = a.note || '（未做内容理解，只知道是真实照片）';
    }
    list.push(item);
  }
  return list;
}

// ---------- 出分镜 ----------
async function doStoryboard(task, { project, assets, char_refs }) {
  const prompt = [project.brief, task.payload?.prompt].filter(Boolean).join('\n');
  if (!prompt.trim()) return { status: 'skipped', note: '项目没有提示词' };
  const dir = path.join(CFG.tmpDir, `job-sb${task.id}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const mats = await understandAssets(dir, assets, prompt);
  fs.rmSync(dir, { recursive: true, force: true });
  mats.forEach((m) => console.log(`[storyboard] 素材${m.no} ${m.desc}`));

  const hhOn = hh.available();
  const script = await chat([
    { role: 'system', content: SB_PERSONA + '\n任务：产出 1080x1920 竖屏短视频分镜脚本，9-11 个场景、总时长约 ' + TARGET_SECS + ' 秒（每镜 4-6 秒）。输出 JSON。' },
    { role: 'user', content: JSON.stringify({
        制片提示词: prompt,
        主角: CHAR_BRIEF,
        定妆参考图: (char_refs || []).map((c) => c.key),
        素材: mats.length ? mats.map((m) => ({ 序号: m.no, 内容: m.desc })) : '无图片素材（空镜可给 search 检索词联网找画面）',
        视频生成通道: hhOn ? '已接入 happyhorse-1.1-i2v（图生视频）：辣条妹出镜做动作、或想让某张实拍素材“动起来”的镜头标 hh=true（最多 4 个），并给 hh_prompt（一句中文：主体动作+镜头运动+氛围，15-60 字，首帧形象由 ref 图决定，专注写怎么动）与 ref（close=定妆特写首帧 / asset=用本镜 img 那张素材做首帧）' : '未配置，全部镜头 hh=false',
        输出格式: {
          scenes: [{
            kicker: '小标签≤8字',
            title: '主文案≤16字，短句有钩子',
            sub: '辅文案≤22字',
            dur: '本镜秒数 4-6',
            vo: '旁白一句话 ≤22字，口语化、适合朗读，连起来是完整故事',
            img: `素材序号（按「内容」描述挑最贴合的，1-${Math.max(mats.length, 1)}）；没有贴合的填 0`,
            search: '仅当 img=0 且 hh=false 时填：联网找画面的检索词（中文，具象）',
            hh: '布尔：该镜是否要 happyhorse 生成动态画面',
            hh_prompt: 'hh=true 时填：动作+镜头运动描述（不必复述外观，首帧由 ref 图定）',
            ref: 'hh=true 时填 close|asset',
          }],
          caption: '发布文案，含钩子前15字，≤120字，贴合制片提示词主题',
          hashtags: ['5个话题标签，含 #辣条妹的御膳房'],
        },
        约束: '有素材时非人物镜头画面以素材为主；画面内容只能是提示词/素材里有的东西；旁白 vo 与画面文案对应同一画面；最后一个场景固定是 CTA；不出现绝对化用语。',
      }) },
  ], { json: true, maxTokens: 4500 });

  if (!Array.isArray(script.scenes) || !script.scenes.length) throw new Error('LLM 没产出任何分镜');
  // 素材序号 → 文件名映射在出片阶段重做（分镜可被人手改，这里只存"序号+路径"两份锚点）。
  const result = {
    scenes: script.scenes,
    caption: script.caption || '',
    hashtags: script.hashtags || [],
    asset_map: mats.map((m) => ({ no: m.no, path: m.path, desc: m.desc })),
    hh_ready: hhOn,
    prompt_used: prompt,
  };
  return { status: 'done', note: `分镜 ${result.scenes.length} 镜已出，等工作区确认/手改`, result };
}

// ---------- 出成片 ----------
async function doVideo(task, { project, assets, steps, char_refs, site, step, p, dir }) {
  // 1) 取分镜：指定 step / 最近一条 done 的 storyboard；被人手改过的 result 原样尊重。
  const sbId = Number(p.storyboard_step_id) || 0;
  let sb = null;
  const cands = (steps || []).filter((s) => s.kind === 'storyboard' && s.status === 'done' && s.result);
  if (sbId) sb = cands.find((s) => s.id === sbId);
  if (!sb) sb = cands[0]; // ListProjectSteps 新在前
  if (!sb) return { status: 'skipped', note: '没有可用分镜，先跑「出分镜」' };
  let script;
  try { script = JSON.parse(sb.result); } catch { throw new Error('分镜 result 不是合法 JSON'); }
  const scenes = (script.scenes || []).slice(0, 11);
  if (!scenes.length) throw new Error('分镜里没有场景');

  // 2) 素材落盘；定妆图走公网 URL（happyhorse i2v 的 first_frame 参考图必须公网可达，
  //    定妆图本就在本站 /uploads/charref/ 下，直接拼绝对 URL，不用下载）。
  const mats = await understandAssets(dir, assets, project.brief || '');
  const siteBase = (site && site.base_url) || CFG.apiBase;
  const refUrls = {};
  for (const c of char_refs || []) {
    refUrls[c.key === 'ip_char_three_view' ? 'three' : 'close'] = siteBase + c.path;
  }
  const matUrl = new Map(mats.map((m) => [m.name, siteBase + m.path]));

  // 3a) 渲染引擎分流：renderer=openmontage → 逐镜动态片段 + OpenMontage 拼接（纯动态版，
  //     无字卡无旁白）；引擎没装则自动退回 hyperframes，不卡单。
  const renderer = String(p.renderer || 'hyperframes');
  if (renderer === 'openmontage') {
    if (!OM.available()) {
      console.warn('[video] 指定 openmontage 引擎但 OPENMONTAGE_DIR 不可用，退回 hyperframes');
    } else {
      return await doVideoOpenMontage({ project, step, scenes, mats, siteBase, refUrls, script, dir });
    }
  }

  // 3) happyhorse 人物镜头（i2v 图生视频）：首帧优先用本镜指派的项目实拍图（asset），
  //    没指派/指派不上的用定妆特写（close）——主角形象从首帧就锁死；
  //    逐镜失败逐镜降级图卡，不整单失败。
  const hhOn = hh.available() && String(await hhSwitch()) === '1';
  let hhBudget = hhOn ? (CFG.hh.maxShots || 4) : 0;
  let hhGot = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const want = sc.hh === true || String(sc.hh).toLowerCase() === 'true';
    sc.hh = false;
    if (!want || hhBudget <= 0) continue;
    hhBudget--;
    const n = Number(sc.img) || 0;
    const m0 = mats.find((m) => m.no === n);
    const assigned = m0 ? siteBase + m0.path : '';
    const firstFrame = (String(sc.ref) === 'asset' && assigned) ? assigned
      : (refUrls.close || refUrls.three || '');
    if (!firstFrame) continue;
    try {
      const clip = await hh.generate(dir, {
        name: `hh${i}`,
        prompt: String(sc.hh_prompt || `${sc.title || ''}，镜头缓慢推进，人物自然动作`).slice(0, 300),
        imageUrl: firstFrame,
        seconds: Math.max(3, Math.min(10, Number(sc.dur) || 5)),
      });
      sc.img = clip; sc.video = true; sc.hh = true; hhGot++;
      console.log(`[video] 镜头${i + 1} happyhorse 片段已生成 ${clip}（首帧 ${firstFrame.slice(-40)}）`);
    } catch (e) {
      console.warn(`[video] 镜头${i + 1} happyhorse 失败，退回图卡:`, e.message);
      sc.img = ''; sc.hh = false;
    }
  }

  // 4) 其余镜头：LLM 指派素材 → 轮转补位 → 没素材才联网（先审后插），与视频工坊同规则。
  const byNo = new Map(mats.map((m) => [m.no, m.name]));
  scenes.forEach((sc) => {
    if (sc.hh && sc.video) return; // 已有动态片段
    const n = Number(sc.img) || 0;
    if (n && byNo.has(n)) { sc.img = byNo.get(n); sc.video = false; }
    else if (!sc.img || typeof sc.img !== 'string' || !media.hasAssetName(sc.img)) sc.img = '';
  });
  if (mats.length) {
    let k = 0;
    scenes.forEach((sc) => {
      if (sc.hh) return;
      if (!sc.img) { sc.img = mats[k % mats.length].name; sc.video = false; k++; }
    });
  }
  const src = mats.length || hhGot ? { need: 0, got: 0 }
    : await media.sourceScenes(dir, scenes, { allowVideo: true, verify: vision.matches });

  // 5) 旁白 + 渲染 + 混音（与 video_mission 同一条流水线）。
  const voOk = A.synthScenes(dir, scenes);
  const { segs, total } = R.planTimeline(scenes, TARGET_SECS);
  const ipName = site.ip_name || '辣条妹的御膳房';
  console.log(`[video] 项目#${project.id} 步骤#${step.id}：happyhorse ${hhGot} 镜 + 素材/联网 ${mats.length ? '素材为主' : `${src.got}/${src.need}`}，旁白 ${voOk}，成片 ${total}s`);
  R.writeProject(dir, { scenes, segs, total, ipName, tagline: site.site_tagline });
  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `proj-${project.id}-s${step.id}-${stamp}.mp4`;
  const tmpOut = path.join(dir, 'out.mp4');
  R.render(dir, tmpOut);
  let finalOut = tmpOut;
  const mix = A.mixTrack(dir, scenes, segs, total, { seed: step.id });
  if (mix) {
    const withAudio = path.join(dir, 'out-vo.mp4');
    if (A.mux(tmpOut, mix, withAudio)) finalOut = withAudio;
  }
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.renameSync(finalOut, outPath);
  const videoUrl = '/uploads/videos/' + outName;

  // 6) 挂抖音待审稿：成片 + 分镜 caption；放行权在人。
  let itemId = 0;
  try {
    const images = mats.map((m) => m.path);
    const created = await api.createSocialItem({
      gen_task_id: task.id, review_id: 0, platform: 'douyin',
      title: (project.title || '项目成片').slice(0, 40),
      body: String(script.caption || project.brief || '').slice(0, 500),
      tags: (script.hashtags || []).map(String), images, video: videoUrl,
      note: `项目#${project.id} 出品（happyhorse ${hhGot} 镜）`,
    });
    itemId = created.id;
  } catch (e) {
    console.warn('[video] 抖音待审稿落库失败:', e.message);
  }
  const result = { video: videoUrl, item_id: itemId, hh_shots: hhGot, scenes: scenes.length, total_secs: total };
  return { status: 'done', note: `成片已出（happyhorse ${hhGot} 镜，旁白 ${voOk} 条${mix ? '，含配乐' : ''}）${itemId ? '，抖音稿待审 #' + itemId : ''}`, result };
}

// ---------- OpenMontage 引擎出片（v13.1） ----------
// 每镜：标了 hh 且有预算 → happyhorse i2v（首帧优先用本镜指派的项目实拍图，
// 没指派用定妆特写）；其余有图 → 本地 zoompan 2.5D 缓推；都没 → 纯色空镜。
// 拼接/混音由 OpenMontage 的 VideoStitch + ffmpeg（om_render.py）完成。
async function doVideoOpenMontage({ project, step, scenes, mats, siteBase, refUrls, script, dir }) {
  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `proj-${project.id}-s${step.id}-${stamp}-om.mp4`;
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let budget = OM.OM_MAX_SHOTS;
  const shots = scenes.map((sc, i) => {
    const n = Number(sc.img) || 0;
    const m = mats.find((x) => x.no === n);
    const wantHH = sc.hh === true || String(sc.hh).toLowerCase() === 'true';
    const useHH = wantHH && budget > 0;
    if (useHH) budget--;
    return {
      index: i + 1,
      prompt: useHH ? String(sc.hh_prompt || `${sc.title || ''}，镜头缓慢推近，人物自然微动`).slice(0, 300) : '',
      first_frame_url: useHH ? ((m ? siteBase + m.path : '') || refUrls.close || refUrls.three || '') : '',
      image_path: m ? path.join(dir, 'assets', m.name) : '',
      duration: Math.max(3, Math.min(10, Number(sc.dur) || 5)),
      title: sc.title || '',
    };
  });
  const total = shots.reduce((s, x) => s + x.duration, 0);
  const bgm = path.join(__dirname, '..', 'vendor', 'bgm', 'Carefree.mp3');
  console.log(`[video] 项目#${project.id} 步骤#${step.id} 走 OpenMontage 引擎：${shots.length} 镜（hh 预算 ${shots.filter((x) => x.first_frame_url).length}），目标 ${total}s`);
  const r = OM.render({
    shots, output_path: outPath, transition: 'cut',
    bgm_path: fs.existsSync(bgm) ? bgm : '',
    target_secs: total, resolution: '1080x1920', fps: 30,
  }, { log: console.log });
  const videoUrl = '/uploads/videos/' + outName;

  let itemId = 0;
  try {
    const created = await api.createSocialItem({
      gen_task_id: step.task_id || 0, review_id: 0, platform: 'douyin',
      title: (project.title || '项目成片').slice(0, 40),
      body: String(script.caption || project.brief || '').slice(0, 500),
      tags: (script.hashtags || []).map(String), images: mats.map((m) => m.path), video: videoUrl,
      note: `项目#${project.id} 出品·OpenMontage（happyhorse ${r.stats.happyhorse} 镜）`,
    });
    itemId = created.id;
  } catch (e) {
    console.warn('[video] 抖音待审稿落库失败:', e.message);
  }
  const st = r.stats || {};
  return {
    status: 'done',
    note: `OpenMontage 动态剪辑版已出（happyhorse ${st.happyhorse || 0} 镜 / 缓推 ${st.zoompan || 0} 镜 / 空镜 ${st.solid || 0}，配乐${st.happyhorse ? '' : '照旧'}）${itemId ? '，抖音稿待审 #' + itemId : ''}`,
    result: { video: videoUrl, item_id: itemId, engine: 'openmontage', stats: st, scenes: scenes.length, total_secs: total },
  };
}

// settings 里的 happyhorse 总开关（服务端拨，worker 不重启生效）。
let _hhSwitch = null;
async function hhSwitch() {
  if (_hhSwitch !== null && Date.now() - _hhSwitchTs < 300_000) return _hhSwitch;
  try {
    const { settings } = await api.settings();
    _hhSwitch = settings.pipeline_happyhorse || '0';
    _hhSwitchTs = Date.now();
  } catch { return '1'; }
  return _hhSwitch;
}
let _hhSwitchTs = 0;

// ---------- 出平台文案 ----------
async function doCopy(task, { project, steps, site, p }) {
  const plats = (Array.isArray(p.platforms) && p.platforms.length ? p.platforms : ['xiaohongshu', 'zhihu', 'weibo', 'douyin']);
  // 有分镜稿就带上它的 caption/hashtags 当底稿。
  let caption = '', hashtags = [];
  const sb = (steps || []).find((s) => s.kind === 'storyboard' && s.status === 'done' && s.result);
  if (sb) { try { const j = JSON.parse(sb.result); caption = j.caption || ''; hashtags = j.hashtags || []; } catch { /* 手改坏了不拦 */ } }
  const pseudo = {
    id: 0, slug: '', dish: project.title, headline: project.title,
    body: [project.brief, caption].filter(Boolean).join('\n'), order_tip: hashtags.map((t) => '#' + t).join(' '),
    score: 0, price: 0, cover: '', images: [], shop: null,
  };
  const items = []; const failed = [];
  for (const name of plats) {
    try {
      const plat = pub.platform(name);
      if (!plat) { failed.push(`${name}: publishers.json 缺配置`); continue; }
      const copy = await social.genCopy(pseudo, { review_base: CFG.apiBase + '/review/', base_url: CFG.apiBase, ip_city: '杭州' }, plat,
        `项目#${project.id}：${(task.payload?.prompt || '').slice(0, 80)}`);
      const created = await api.createSocialItem({
        gen_task_id: task.id, review_id: 0, platform: name,
        title: copy.title, body: copy.body, tags: copy.tags, images: [], video: '',
        note: `项目#${project.id} 出品`,
      });
      items.push(created.id);
    } catch (e) {
      failed.push(`${name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!items.length) throw new Error('平台稿全部失败：' + (failed.join('；') || '无可用平台'));
  return { status: 'done', note: `${items.length} 条平台稿待审（#${items.join(' #')}）`, result: { items, failed } };
}

module.exports = { type: 'project_step', run };
