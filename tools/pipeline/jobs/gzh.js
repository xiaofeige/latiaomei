'use strict';
// gzh：已发布点评 → 公众号图文。配了凭证直接进公众号草稿箱；
// 没配凭证则把成稿写到 /uploads/gzh/（JSON），辣条妹复制粘贴发。
const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { chat, PERSONA } = require('../lib/llm');
const { CFG } = require('../lib/env');

// access_token 缓存（有效期 7200s，留 5 分钟余量）
let tokenCache = { tok: '', exp: 0 };
async function gzhToken() {
  if (tokenCache.tok && Date.now() < tokenCache.exp) return tokenCache.tok;
  const u = new URLSearchParams({ grant_type: 'client_credential', appid: CFG.gzh.appid, secret: CFG.gzh.secret });
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/token?' + u, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (!j.access_token) throw new Error('公众号 token 失败：' + JSON.stringify(j).slice(0, 200) + '（检查 IP 白名单）');
  tokenCache = { tok: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tokenCache.tok;
}

async function runGzh(task) {
  if (!task.review_id) return { status: 'skipped', note: 'gzh 任务未绑定内容' };
  const { review: rv, site } = await api.getReview(task.review_id);
  const abs = (x) => (x && x.startsWith('/') ? site.base_url + x : x);
  const { settings } = await api.settings();

  const art = await chat([
    { role: 'system', content: PERSONA + '\n任务：把点评扩写成一篇公众号图文。输出 JSON。风格：公众号美食号但保留辣条妹口吻，800-1200字，HTML 片段（只允许 p/h2/strong/img，图片用给定 URL），开头 3 行内给钩子。' },
    { role: 'user', content: JSON.stringify({
        点评: { dish: rv.dish, headline: rv.headline, body: rv.body, order_tip: rv.order_tip, score: rv.score, price: rv.price, shop: rv.shop?.name, cover: abs(rv.cover) },
        输出格式: { title: '≤24字', digest: '摘要≤120字（公众号列表页用）', author: settings.ip_name, html: '正文HTML' },
      }) },
  ], { json: true });

  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');

  if (CFG.gzh.appid && CFG.gzh.secret) {
    const tok = await gzhToken();
    const res = await fetch('https://api.weixin.qq.com/cgi-bin/draft/add?access_token=' + tok, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ articles: [{
        title: art.title, author: art.author || settings.ip_name, digest: art.digest,
        content: art.html, thumb_media_id: '', need_open_comment: 1, only_fans_can_comment: 0,
      }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json();
    if (!j.media_id) throw new Error('公众号草稿写入失败：' + JSON.stringify(j).slice(0, 200));
    return { status: 'done', result: { review_id: rv.id, gzh_draft_id: j.media_id, title: art.title, published_to: 'gzh:draft-box' } };
  }

  // 降级：成稿落盘，管理端任务详情可查 result。
  const outDir = path.join(CFG.uploadsDir, 'gzh');
  fs.mkdirSync(outDir, { recursive: true });
  const name = `r${rv.id}-${stamp}.json`;
  fs.writeFileSync(path.join(outDir, name), JSON.stringify({ ...art, review_id: rv.id, url: `${site.review_base}${rv.slug || rv.id}` }, null, 2));
  return { status: 'done', result: { review_id: rv.id, article_file: '/uploads/gzh/' + name, title: art.title, note: '未配公众号凭证，成稿已落盘待手动发布' } };
}

module.exports = { type: 'gzh', run: runGzh };
