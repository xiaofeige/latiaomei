'use strict';
// video：已发布点评 → LLM 分镜+旁白 → 联网搜图作画面 → hyperframes 渲染竖屏视频 →
// edge-tts 逐镜配音 + CC-BY BGM 混音 → 存 /uploads/videos/。
// 抖音开放平台发布需企业资质+审核，凭证到位前先把"成品+文案"产出，人工一键搬运。
const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { chat, PERSONA } = require('../lib/llm');
const R = require('../lib/render');
const media = require('../lib/media');
const A = require('../lib/audio');
const vision = require('../lib/vision');
const { CFG } = require('../lib/env');

// 成片目标时长（秒）：短视频拉到 ~50s，靠多分镜 + 每镜 5s 支撑，不再是十几秒的字卡。
const TARGET_SECS = Number(process.env.VIDEO_TARGET_SECS || 50);

function dayStartUnix() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

async function overDailyCap() {
  try {
    const { tasks } = await api.tasks('status=done&type=video&limit=200');
    const start = dayStartUnix();
    return tasks.filter((t) => t.finished_at >= start).length >= CFG.videoDailyCap;
  } catch { return false; } // 查询失败不拦产能
}

async function runVideo(task) {
  if (!task.review_id) return { status: 'skipped', note: '视频任务未绑定内容' };
  if (await overDailyCap()) return { status: 'skipped', note: `已达当日视频产能上限 ${CFG.videoDailyCap}` };

  const { review: rv, site } = await api.getReview(task.review_id);
  const { settings } = await api.settings();
  const ipName = settings.ip_name || '辣条妹的御膳房';
  const abs = (u) => (u && u.startsWith('/') ? site.base_url + u : u);

  const script = await chat([
    { role: 'system', content: PERSONA + '\n任务：把一条点评改写成 1080x1920 竖屏短视频分镜脚本，9-11 个场景、总时长约 ' + TARGET_SECS + ' 秒（每镜 4-6 秒）。输出 JSON。' },
    { role: 'user', content: JSON.stringify({
        点评: { dish: rv.dish, headline: rv.headline, body: rv.body, order_tip: rv.order_tip, score: rv.score, price: rv.price, tier: rv.tier },
        输出格式: {
          scenes: [{
            kicker: '小标签≤8字',
            title: '主文案≤16字，短句有钩子',
            sub: '辅文案≤22字',
            dur: '本镜秒数 4-6',
            vo: '旁白一句话 ≤22字，口语化、适合朗读，连起来是完整故事',
            search: '用于联网找画面的检索词（中文，具象：菜名/场景/食材/杭州地标，勿写抽象词）',
            video: '布尔，该镜是否想用短视频片段（整片最多 2-3 个 true，其余 false）',
          }],
          caption: '抖音发布文案，含钩子前15字，≤120字',
          hashtags: ['5个话题标签，含 #辣条妹的御膳房 #杭州美食'],
        },
        约束: '每镜都要配一个能检索到真实图片的 search 词（这是画面的来源，不能只靠文字），还要给 vo 旁白（成片会逐镜配音）。首镜 search 用主打菜特写；中间穿插店铺环境/食材/杭州街景；最后一个场景固定是 CTA（search 用店铺门头或招牌菜）。不出现绝对化用语。',
      }) },
  ], { json: true, maxTokens: 4000 });

  const dir = path.join(CFG.tmpDir, `job-v${task.id}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  // 场景画面：主动联网搜图/搜视频剪辑进来；点评封面作为首镜兜底（若搜不到）。
  const scenes = (script.scenes || []).slice(0, 11);
  // 点评封面是真实菜品图，首镜优先挂真图（v12：以前先搜网图、封面只当兜底，首镜经常不是本店本菜）。
  if (rv.cover && scenes.length) {
    const img0 = await media.download(dir, abs(rv.cover), 'cover', { kind: 'image' });
    if (img0) { scenes[0].img = img0.name; scenes[0].video = false; }
  }
  // 联网搜图每张先过视觉模型审核“对不对题”再插（v12，防 Bing 图库乱入）。
  const src = await media.sourceScenes(dir, scenes, { allowVideo: true, verify: vision.matches });
  if (rv.cover && !media.hasAssetName(scenes[0] && scenes[0].img)) {
    const img = await media.download(dir, abs(rv.cover), 'cover', { kind: 'image' });
    if (img) { scenes[0].img = img.name; scenes[0].video = false; }
  }
  // 旁白：逐镜 edge-tts 合成（失败退静音），每镜时长自动适应旁白长度。
  const voOk = A.synthScenes(dir, scenes);
  const { segs, total } = R.planTimeline(scenes, TARGET_SECS);
  console.log(`[video] 素材 ${src.got}/${src.need} 镜联网命中，旁白 ${voOk}/${scenes.length} 条，成片 ${total}s`);
  R.writeProject(dir, { scenes, segs, total, ipName, tagline: settings.site_tagline });

  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `r${rv.id}-${stamp}.mp4`;
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  const tmpOut = path.join(dir, 'out.mp4');
  R.render(dir, tmpOut);
  // 配音+配乐混进成片；任一步失败保留无声版，不卡流水线。
  let finalOut = tmpOut;
  const mix = A.mixTrack(dir, scenes, segs, total, { seed: rv.id });
  if (mix) {
    const withAudio = path.join(dir, 'out-vo.mp4');
    if (A.mux(tmpOut, mix, withAudio)) finalOut = withAudio;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.renameSync(finalOut, outPath);

  // 清渲染项目目录（产物已搬走）
  fs.rmSync(dir, { recursive: true, force: true });

  // TODO(抖音开放平台凭证到位后)：此处直传发布，成功后把视频号写进 result。
  return {
    status: 'done',
    note: `成片已出（画面 ${src.got}/${src.need}，旁白 ${voOk} 条${mix ? '，含配乐' : ''}）`,
    result: {
      review_id: rv.id, dish: rv.dish,
      video: '/uploads/videos/' + outName,
      caption: script.caption, hashtags: script.hashtags,
      published_to: 'douyin:pending-manual', // 成品待一键搬运；接口打通后改 douyin:api
    },
  };
}

module.exports = { type: 'video', run: runVideo };
