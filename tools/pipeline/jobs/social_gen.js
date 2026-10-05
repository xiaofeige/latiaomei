'use strict';
// social_gen（v9）：管理小程序「发任务」/发布自动入队 → AI 按平台风格产文案 →
// 全部落 social_items（服务端强制 pending 待审）。本 job 一个发布动作都不做：
// 放行权在辣条妹手里，放行动作才会入队真正的平台发布任务。
const api = require('../lib/api');
const social = require('../lib/social');
const pub = require('../lib/publishers');

const PLATFORMS = pub.PLATFORMS;

async function run(task) {
  const p = task.payload || {};
  const reviewId = p.review_id || task.review_id;
  if (!reviewId) return { status: 'skipped', note: '任务未绑定内容' };
  const want = Array.isArray(p.platforms) && p.platforms.length ? p.platforms : PLATFORMS;
  const platforms = want.filter((x) => PLATFORMS.includes(x));
  if (!platforms.length) return { status: 'skipped', note: `payload.platforms 无合法平台：${JSON.stringify(p.platforms)}` };

  const { review: rv, site } = await api.getReview(reviewId);
  // 抖音视频渠道：先看有没有成片可挂（没有也照常产文案待审，发布时再催产补片）。
  const vres = platforms.includes('douyin') ? await social.findVideo(rv.id) : null;
  const items = [];
  const failed = [];
  for (const name of platforms) {
    const plat = pub.platform(name);
    if (!plat) { failed.push(`${name}: publishers.json 缺配置`); continue; }
    try {
      const copy = await social.genCopy(rv, site, plat, p.note);
      const images = name === 'douyin' ? [] : [rv.cover, ...(rv.images || [])].filter(Boolean);
      const created = await api.createSocialItem({
        gen_task_id: task.id,
        review_id: rv.id,
        platform: name,
        title: copy.title,
        body: copy.body,
        tags: copy.tags,
        images,
        video: name === 'douyin' && vres ? vres.video : '', // /uploads/videos/*.mp4，发布时再验在不在
        note: p.auto ? '发布自动产出' : `辣条妹任务${p.by ? '·' + p.by : ''}`,
      });
      items.push(created.id);
    } catch (e) {
      // 单平台失败（多为 LLM 配额/网络）不拖垮整单：其余平台继续，失败原因进 note。
      failed.push(`${name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!items.length) throw new Error(`四平台文案全部失败：${failed.join('；') || '无可用平台'}`);
  const note = `已产 ${items.length} 条待审文案（#${items.join(' #')}），等辣条妹放行` +
    (failed.length ? `；失败：${failed.join('；')}` : '');
  return { status: 'done', note, result: { items, failed, review_id: rv.id, platforms } };
}

module.exports = { type: 'social_gen', run };
