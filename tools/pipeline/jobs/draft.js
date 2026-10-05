'use strict';
// draft：辣条妹的指令 → AI 产点评草稿（status=draft，服务端强制）。
// 机器只能提案；发布前必须由辣条妹在管理小程序审核（补实拍图、改口吻、放行）。
const api = require('../lib/api');
const { chat, PERSONA } = require('../lib/llm');

const SLUG_SEED = () => Math.random().toString(36).slice(2, 8);

async function runDraft(task) {
  const { directives } = await api.directives();
  // 优先领与任务绑定的指令；没有就领最早一条 open 的 topic/promo。
  let d = task.payload?.directive_id
    ? directives.find((x) => x.id === task.payload.directive_id)
    : directives.find((x) => ['topic', 'promo'].includes(x.kind));
  if (!d) return { status: 'skipped', note: '当前没有待执行的选题指令' };
  if (d.kind === 'block') return { status: 'skipped', note: 'block 指令由调度侧处理' };

  const draft = await chat([
    { role: 'system', content: PERSONA + '\n任务：根据指令产出一条杭州探店点评草稿，输出 JSON。素材不足时允许虚构"示例店铺"但必须在正文首段标注【示例稿·待替换真实探店】。' },
    { role: 'user', content: JSON.stringify({
        指令标题: d.title, 指令要求: d.brief, 日期: d.date,
        输出格式: {
          slug: 'ai-<日期>-<6位随机>，小写字母数字连字符',
          dish: '菜名（具体到一道菜）',
          kind: 'tandian 或 yushanfang',
          tier: 'npc | elite | boss 之一（普通店 npc，好吃的 elite，顶配 boss）',
          score: '0-5 分，一位小数以内', spicy: '0-3', price: '人均，整数元',
          headline: '一句话标题，15字内，毒舌公道',
          body: '正文 300-500 字，分段，口吻见人设',
          order_tip: '点单贴士，一句话',
          revisit: '1-5 回头意愿',
          tastes: '口味标签数组，如 ["辣","糯","锅气"]',
        },
      }) },
  ], { json: true, temperature: 0.9 });

  if (!draft.slug) draft.slug = `ai-${(d.date || new Date().toISOString().slice(0, 10)).replaceAll('-', '')}-${SLUG_SEED()}`;
  draft.visit_date = draft.visit_date || d.date || new Date().toISOString().slice(0, 10);
  draft.source_directive = d.id;

  const saved = await api.createReview(draft);
  await api.directiveDone(d.id, 'done', `已产草稿 #${saved.id}《${saved.dish}》，待审核`);
  return { status: 'done', result: { review_id: saved.id, dish: saved.dish, slug: saved.slug } };
}

module.exports = { type: 'draft', run: runDraft };
