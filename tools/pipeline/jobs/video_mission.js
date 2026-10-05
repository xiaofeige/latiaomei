'use strict';
// video_mission（v10 视频工坊）：管理小程序 Tab3 下单的自由任务——
// 素材（多图/多文件）+ 结构化提示词 → LLM 出分镜 → hyperframes 渲染竖屏成片 →
// 每个目标平台落一条 social_item（抖音挂成片，图文平台挂素材图+平台稿），全部 pending。
// 铁律不变：本 job 一个发布动作都不做，放行权在辣条妹手里。
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
const { CFG } = require('../lib/env');

// 成片目标时长（秒）。
const TARGET_SECS = Number(process.env.VIDEO_TARGET_SECS || 50);

// 视频工坊任务不一定是美食（家人/宠物/日常都有）。v12 根因修复：以前强套
// 辣条妹美食老饕人设 → LLM 把“父女视频通话”编成吃片儿川/抢葱包桧的食探脚本，
// 文案/旁白/画面一起跑偏。人设只保留在点评美食任务（jobs/video.js）里。
const MISSION_PERSONA = `你是短视频编导，口吻口语化、有钩子，不写营销号腔、不堆形容词、不用绝对化用语（广告法）。
铁律：只能基于给定的制片提示词与素材描述进行创作，严禁编造没出现的人物、动作、食物、场景；
旁白（vo）必须与画面文案（title/sub）说的是同一件事，连起来是一个完整故事。`;

// 素材路径（/uploads/...）转本机可读 URL：Go 服务与 worker 同机，走回环最快。
const abs = (u) => (u && u.startsWith('/') ? CFG.apiBase + u : u);

async function run(task) {
  const p = task.payload || {};
  const prompt = String(p.prompt || '').trim();
  if (!prompt) return { status: 'skipped', note: '任务没有提示词' };
  const plats = Array.isArray(p.platforms) && p.platforms.length ? p.platforms : ['douyin'];
  const images = (Array.isArray(p.images) ? p.images : []).filter((x) => typeof x === 'string' && x.startsWith('/uploads/'));
  const title = String(p.title || '').trim() || (prompt.slice(0, 18) + (prompt.length > 18 ? '…' : ''));

  // 1) 素材理解（v12）：先把用户图逐张“看过”（视觉模型描述），分镜 LLM 才能按内容指派。
  //    以前 LLM 只拿到图片数量，img 序号纯盲填 → 图文对不上。
  const dir = path.join(CFG.tmpDir, `job-vm${task.id}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const assets = [];
  for (let i = 0; i < images.length; i++) {
    const got = await media.download(dir, abs(images[i]), `a${i}`, { kind: 'image' });
    if (got) assets.push({ no: assets.length + 1, name: got.name });
  }
  if (assets.length) {
    if (vision.available()) {
      console.log(`[video_mission] 视觉模型逐张理解 ${assets.length} 张素材...`);
      for (const a of assets) {
        a.desc = await vision.describe(path.join(dir, 'assets', a.name), prompt.slice(0, 120))
          || '（描述失败，内容未知）';
      }
    } else {
      console.warn('[video_mission] 未配 LLM_VISION_MODEL，素材内容未知，分镜只能按顺序轮转填图');
      assets.forEach((a) => { a.desc = '（未做内容理解，只知道是用户上传的真实照片）'; });
    }
    assets.forEach((a) => console.log(`[video_mission]   素材${a.no} ${a.name}: ${a.desc}`));
  }

  // 2) 分镜脚本：把制片提示词 + 素材描述转成 1080x1920 竖屏分镜 + 抖音发布文案。
  const script = await chat([
    { role: 'system', content: MISSION_PERSONA + '\n任务：产出 1080x1920 竖屏短视频分镜脚本，9-11 个场景、总时长约 ' + TARGET_SECS + ' 秒（每镜 4-6 秒）。输出 JSON。' },
    { role: 'user', content: JSON.stringify({
        制片提示词: prompt,
        素材: assets.length
          ? assets.map((a) => ({ 序号: a.no, 内容: a.desc }))
          : '无可用图片素材（每镜都要给 search 检索词联网找画面）',
        附件数: (p.files || []).length,
        输出格式: {
          scenes: [{
            kicker: '小标签≤8字',
            title: '主文案≤16字，短句有钩子',
            sub: '辅文案≤22字',
            dur: '本镜秒数 4-6',
            vo: '旁白一句话 ≤22字，口语化、适合朗读，连起来是完整故事',
            img: `素材序号（按上面「内容」描述挑最贴合本镜画面的那张，1-${Math.max(assets.length, 1)}）；没有素材或没有一张贴合的填 0`,
            search: '仅当 img=0 时填：联网找画面的检索词（中文，具象，与人物/地标/实物相关，勿写抽象词）',
            video: '布尔，该镜是否想用短视频片段（有用户素材时一律 false）',
          }],
          caption: '发布文案，含钩子前15字，≤120字，贴合制片提示词主题',
          hashtags: ['5个话题标签，含 #辣条妹的御膳房'],
        },
        约束: '有素材时画面以素材为主：每镜尽量指派贴合的素材序号，同一素材可多镜复用，不要把同一镜既指派素材又指望联网图；画面内容只能是提示词/素材里有的东西（没提到吃就不要写吃）；旁白 vo 与画面文案必须对应同一画面。最后一个场景固定是 CTA。不出现绝对化用语。',
      }) },
  ], { json: true, maxTokens: 4000 });

  // 3) 渲染成片：先按 LLM 指派落素材（基于内容描述，不再是盲填）；  //    没指派到的空镜轮转填用户素材（真人真图 >> 不相干网图）；完全没素材才联网搜（搜到也先审再插）。
  const scenes = (script.scenes || []).slice(0, 11).map((sc, i) => ({ ...sc, title: sc.title || `镜头 ${i + 1}` }));
  if (!scenes.length) throw new Error('LLM 没产出任何分镜');
  const byNo = new Map(assets.map((a) => [a.no, a.name]));
  scenes.forEach((sc) => {
    const n = Number(sc.img) || 0;
    if (n && byNo.has(n)) { sc.img = byNo.get(n); sc.video = false; }
    else sc.img = ''; // LLM 填了 0/越界/杂值 → 清空，交给后面的轮转/搜集
  });
  if (assets.length) {
    let k = 0;
    scenes.forEach((sc) => {
      if (!sc.img) { sc.img = assets[k % assets.length].name; sc.video = false; k++; }
    });
  }
  // 没挂上素材的场景 → 主动联网搜集画面；配了视觉模型则每张图先审“对不对题”再插（v12）。
  const src = assets.length ? { need: 0, got: 0 } : await media.sourceScenes(dir, scenes, { allowVideo: true, verify: vision.matches });
  // 旁白：逐镜 edge-tts 合成（失败退静音），每镜时长自动适应旁白长度。
  const voOk = A.synthScenes(dir, scenes);
  const { segs, total } = R.planTimeline(scenes, TARGET_SECS);
  const { settings } = await api.settings();
  const ipName = settings.ip_name || '辣条妹的御膳房';
  const userImgScenes = scenes.filter((sc) => typeof sc.img === 'string' && sc.img.startsWith('a')).length;
  console.log(`[video_mission] 画面：用户图 ${userImgScenes} 镜 + 联网 ${src.got}/${src.need} 镜，旁白 ${voOk}/${scenes.length} 条，成片 ${total}s`);
  R.writeProject(dir, { scenes, segs, total, ipName, tagline: settings.site_tagline });

  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `vm-${task.id}-${stamp}.mp4`;
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  const tmpOut = path.join(dir, 'out.mp4');
  R.render(dir, tmpOut);
  // 配音+配乐混进成片；任一步失败保留无声版，不卡流水线。
  let finalOut = tmpOut;
  const mix = A.mixTrack(dir, scenes, segs, total, { seed: task.id });
  if (mix) {
    const withAudio = path.join(dir, 'out-vo.mp4');
    if (A.mux(tmpOut, mix, withAudio)) finalOut = withAudio;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.renameSync(finalOut, outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  const videoUrl = '/uploads/videos/' + outName;

  // 4) 每个平台落一条待审稿。抖音挂成片；图文平台挂素材图 + 按平台风格另产文案。
  const items = [];
  const failed = [];
  for (const name of plats) {
    try {
      const plat = pub.platform(name);
      if (!plat) { failed.push(`${name}: publishers.json 缺配置`); continue; }
      if (name === 'douyin') {
        const created = await api.createSocialItem({
          gen_task_id: task.id, review_id: 0, platform: name,
          title: title.slice(0, 40), body: String(script.caption || '').slice(0, 500),
          tags: (script.hashtags || []).map(String), images, video: videoUrl,
          note: `视频工坊出品${p.by ? '·' + p.by : ''}`,
        });
        items.push(created.id);
      } else {
        const pseudo = {
          id: 0, slug: '', dish: title, headline: title, body: prompt, order_tip: '',
          score: 0, price: 0, cover: images[0] || '', images, shop: null,
        };
        const { site } = { site: { review_base: CFG.apiBase + '/review/', base_url: CFG.apiBase, ip_city: '杭州' } };
        const copy = await social.genCopy(pseudo, site, plat, p.prompt ? '视频工坊任务：' + String(p.prompt).slice(0, 80) : '');
        const created = await api.createSocialItem({
          gen_task_id: task.id, review_id: 0, platform: name,
          title: copy.title, body: copy.body, tags: copy.tags, images, video: '',
          note: `视频工坊出品${p.by ? '·' + p.by : ''}（同题图文稿）`,
        });
        items.push(created.id);
      }
    } catch (e) {
      failed.push(`${name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!items.length) throw new Error('成片已渲染，但平台稿全部失败：' + (failed.join('；') || '无可用平台'));

  return {
    status: 'done',
    note: `成片已出（联网素材 ${src.got}/${src.need}，旁白 ${voOk} 条${mix ? '，含配乐' : ''}），${items.length} 条待审（#${items.join(' #')}）` + (failed.length ? `；失败：${failed.join('；')}` : ''),
    result: { video: videoUrl, items, failed, title, platforms: plats },
  };
}

module.exports = { type: 'video_mission', run };
