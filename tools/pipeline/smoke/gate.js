// 离线冒烟：验证 v9 人审闸门 + 凭证未配时的「发布包」降级路径（不碰生产库、不打 LLM）。
// 做法：把 lib/api.js 换成假实现，只 require 真实的 lib/social.js / lib/publishers.js。
const path = require('path');
const Module = require('module');

const PIPE = require('path').join(__dirname, '..');
process.env.UPLOADS_DIR = process.env.SMOKE_UPLOADS || '/tmp/smoke-uploads';

const calls = [];
const fakeItem = {
  id: 900, status: 'approved', platform: 'xiaohongshu',
  title: '虾爆鳝面的锅气', body: '正文一\n正文二', tags: ['杭州美食', '探店'],
  images: ['/uploads/nope-1.jpg'], video: '',
};
const fakeReview = {
  id: 1, dish: '虾爆鳝面', headline: '头汤足', body: '面体筋道', order_tip: '加浇头',
  score: 4.5, price: 38, tier_label: '夯', shop: { name: '某面馆' }, slug: 'xia-bao-shan-mian',
  cover: '/uploads/nope-cover.jpg', images: ['/uploads/nope-2.jpg'],
};
const fake = {
  poll: async () => ({ tasks: [] }),
  finish: async () => ({}),
  enqueue: async (type, rid, runAfter, payload) => { calls.push(['enqueue', type, rid, runAfter, payload]); return { added: true }; },
  getReview: async () => ({ review: fakeReview, site: { ip_city: '杭州', review_base: 'https://x/' } }),
  getSocialItem: async (id) => { calls.push(['getSocialItem', id]); return id === 900 ? fakeItem : null; },
  socialItemResult: async (id, st, res, note) => { calls.push(['socialItemResult', id, st, note]); return {}; },
  createSocialItem: async () => ({}),
  tasks: async (q) => ({ tasks: [] }),
  claim: async () => ({}),
};
const apiPath = path.join(PIPE, 'lib', 'api.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const f = origResolve.call(this, request, parent, ...rest);
  return f === apiPath ? '/tmp/fake-api.js' : f;
};
require('fs').writeFileSync('/tmp/fake-api.js', 'module.exports=' + JSON.stringify(Object.keys(fake)) + '.reduce((o,k)=>(o[k]=(...a)=>global.__api[k](...a),o),{});');
global.__api = fake;

const social = require(path.join(PIPE, 'lib', 'social.js'));

(async () => {
  let fail = 0;
  const chk = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name, extra || ''); if (!cond) fail++; };

  // ① 没有 item_id（未经放行）→ 必须 skip，且绝不产发布包
  let r = await social.publish({ review_id: 1, payload: null }, 'xiaohongshu');
  chk('未放行任务被拒', r.status === 'skipped' && /未经人审放行/.test(r.note), r.note);

  // ② item 不存在 → skip
  r = await social.publish({ review_id: 1, payload: { item_id: 12345 } }, 'xiaohongshu');
  chk('不存在的稿被拒', r.status === 'skipped' && /不存在/.test(r.note), r.note);

  // ③ 待审（未放行）状态 → skip
  fakeItem.status = 'pending';
  r = await social.publish({ review_id: 1, payload: { item_id: 900 } }, 'xiaohongshu');
  chk('pending 稿不发布', r.status === 'skipped' && /未放行不发布/.test(r.note), r.note);
  fakeItem.status = 'approved';

  // ④ 已放行 + cookie 未配 → 降级发布包，item 不标 published
  calls.length = 0;
  r = await social.publish({ review_id: 1, payload: { item_id: 900 } }, 'xiaohongshu');
  const packPath = '/tmp/smoke-uploads/social/xiaohongshu' + r.result.pack.split('/xiaohongshu')[1];
  chk('降级为发布包', r.status === 'done' && r.result.published_to === 'manual:pack', r.note);
  chk('发布包已落盘', require('fs').existsSync(packPath), packPath);
  chk('未回填 published（凭证没配不算发布）', !calls.some((c) => c[0] === 'socialItemResult'));
  console.log('--- 发布包内容 ---\n' + require('fs').readFileSync(packPath, 'utf8'));

  // ⑤ 微博 tag 风格 #词# 与知乎 article 无图也能发
  for (const pf of ['weibo', 'zhihu']) {
    r = await social.publish({ review_id: 1, payload: { item_id: 900 } }, pf);
    const body = require('fs').readFileSync('/tmp/smoke-uploads/social/' + pf + r.result.pack.split(pf)[1], 'utf8');
    chk(pf + ' 发布包话题风格', r.status === 'done' && /#/.test(body), (r.result.pack || r.note));
  }

  // ⑥ 抖音（video 渠道）无成片 → 催产 video + 顺延自己 2h，且不算失败
  calls.length = 0;
  r = await social.publish({ review_id: 1, payload: { item_id: 900 } }, 'douyin');
  const enq = calls.filter((c) => c[0] === 'enqueue');
  const d = enq.filter((c) => c[1] === 'douyin')[0];
  chk('抖音无片：催产 video', enq.some((c) => c[1] === 'video'), JSON.stringify(enq.map((c) => c[1])));
  chk('抖音无片：带 item_id 顺延 2h', !!d && d[4] && d[4].item_id === 900 && Math.abs(d[3] - (Date.now() / 1000 + 7200)) < 10,
    d ? 'run_after +' + Math.round(d[3] - Date.now() / 1000) + 's payload=' + JSON.stringify(d[4]) : '无 douyin 入队');
  chk('抖音无片：本轮 skip 不烧重试', r.status === 'skipped', r.note);

  console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
