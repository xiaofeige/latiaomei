'use strict';
// 社媒自动发布引擎（douyin / xiaohongshu / zhihu / weibo 共用）。
// 流程：点评 → LLM 按平台风格产文案 →
//   ① publishers.json 凭证齐：puppeteer-core 驱动无头 Chromium，注入 cookie、打开创作端、
//      传图/传视频、填标题正文；auto_publish=true 才点「发布」，否则停在预填态截屏为证。
//   ② 凭证没配/未启用：降级成「发布包」(/uploads/social/<平台>/r<id>-*.md)，复制粘贴即发。
// 渠道调性（publishers.json 的 media 字段）：video=抖音只发视频，没片先催产 video 任务再顺延自己；
// image=小红书/微博图文为主；article=知乎长文（图只是点缀，无图照发）。
// 无论走哪条路，发布包和截屏都落盘——机器留证据，人随时可查。
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { chat, PERSONA } = require('./llm');
const { CFG } = require('./env');
const pub = require('./publishers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '') + '-' + Math.random().toString(36).slice(2, 8);

// URL 路径（/uploads/...）→ 服务器本地文件路径；不存在返回 null。
function localPath(urlPath) {
  if (!urlPath || !urlPath.startsWith('/uploads/')) return null;
  const p = path.join(CFG.uploadsDir, urlPath.slice('/uploads/'.length));
  return fs.existsSync(p) ? p : null;
}

// 找这条点评最新的已渲染视频（video 任务产物），没有返回 null。
async function findVideo(reviewId) {
  try {
    const { tasks } = await api.tasks('type=video&status=done&limit=30');
    const t = (tasks || []).find((x) => x.review_id === reviewId);
    if (!t) return null;
    const r = JSON.parse(t.result || '{}');
    return localPath(r.video) ? r : null;
  } catch {
    return null;
  }
}

// LLM 按平台风格产文案；截断兜底（模型偶尔不守字数）。
async function genCopy(rv, site, p, note) {
  const out = await chat([
    { role: 'system', content: PERSONA + `\n任务：把一条点评改写成「${p.label}」平台的发布文案。输出 JSON。要求：${p.style_guide}；标题≤${p.title_max || '不限'}字，正文≤${p.body_max}字，不得编造素材外的店名/价格。` },
    { role: 'user', content: JSON.stringify({
        点评: { dish: rv.dish, headline: rv.headline, body: rv.body, order_tip: rv.order_tip,
          score: rv.score, price: rv.price, tier: rv.tier_label, shop: rv.shop?.name,
          city: site.ip_city, site_url: `${site.review_base}${rv.slug || rv.id}` },
        ...(note ? { 甲方备注: `辣条妹的要求：${note}` } : {}),
        输出格式: { title: `标题（${p.title_max ? `≤${p.title_max}字` : '可留空'}）`, body: `正文纯文本≤${p.body_max}字（不含话题标签）`, tags: ['话题词', '不带#号'] },
      }) },
  ], { json: true });
  const title = String(out.title || rv.headline || rv.dish).slice(0, p.title_max || 999);
  const body = String(out.body || rv.body).slice(0, p.body_max);
  const tags = (Array.isArray(out.tags) ? out.tags : []).map(String).filter(Boolean).slice(0, 10);
  return { title, body, tags };
}

// 话题标签拼成一行：#词（抖音/小红书/知乎）、#词#（微博）、无（不追加）。
function tagLine(p, tags) {
  if (!tags.length || p.tag_style === '无') return '';
  if (p.tag_style === '#话题#') return tags.map((t) => `#${t.replace(/^#|#$/g, '')}#`).join(' ');
  return tags.map((t) => `#${t.replace(/^#/g, '')}`).join(' ');
}

// 发布包（md）：人工复制粘贴用，也是自动模式的"发什么"存档。
function writePack(p, rv, copy, media, note) {
  const dir = path.join(CFG.uploadsDir, 'social', p._name);
  fs.mkdirSync(dir, { recursive: true });
  const name = `r${rv.id}-${stamp()}.md`;
  const lines = [
    `# 【${p.label}发布包】${copy.title || rv.dish}`,
    `- 内容：点评 #${rv.id} ${rv.dish}（${rv.shop?.name || ''}）`,
    `- 入口：${p.url}`,
    `- 状态：${note}`,
    '',
    copy.title ? `标题：${copy.title}` : '',
    '',
    '正文：',
    copy.body + (copy.tags.length && p.tag_style !== '无' ? '\n\n' + tagLine(p, copy.tags) : ''),
    '',
    media.video ? `视频素材：${media.video}` : `图片素材：\n${media.images.map((x) => '- ' + x).join('\n')}`,
  ];
  fs.writeFileSync(path.join(dir, name), lines.filter((l) => l !== '').join('\n'));
  return '/uploads/social/' + p._name + '/' + name;
}

// ---- 浏览器自动化 ----

async function firstSelector(page, sels) {
  for (const s of sels || []) {
    try {
      const el = await page.$(s);
      if (el) return el;
    } catch { /* 非法选择器跳过 */ }
  }
  return null;
}

// 按可见文本点按钮（这些平台按钮文案稳定、class 全是哈希）。
async function clickByText(page, texts) {
  for (const t of texts) {
    const ok = await page.evaluate((txt) => {
      const els = [...document.querySelectorAll('button, [role=button], div[class*=btn], span')];
      const el = els.find((e) => e.offsetParent && (e.textContent || '').trim() === txt);
      if (el) { el.click(); return true; }
      return false;
    }, t);
    if (ok) return true;
  }
  return false;
}

async function browserPublish(p, copy, media, rv, logDir, tag) {
  const puppeteer = require('puppeteer-core');
  const b = p._browser;
  const browser = await puppeteer.launch({
    executablePath: b.chrome_path,
    headless: b.headless !== false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie(...pub.parseCookie(p.cookie, p.cookie_domain));
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: b.nav_timeout_ms || 60000 });
    await sleep(4000); // 创作端全是 SPA，给前端框架点时间

    const snap = async (label) => {
      try {
        await page.screenshot({ path: path.join(logDir, `${p._name}-r${rv.id}-${tag}-${label}.png`) });
      } catch { /* 截屏失败不影响主流程 */ }
    };
    await snap('open');

    if (p.login_check && !(await firstSelector(page, [p.login_check]))) {
      throw new Error(`${p.label} cookie 可能已过期：页面里找不到编辑区（${p.login_check}）。重新登录复制 cookie 到 publishers.json 即可，配置热生效。`);
    }

    const files = media.video ? [media.video] : media.images.slice(0, p.max_images || 9);
    const inp = await firstSelector(page, p.selectors.upload_input);
    if (inp && files.length) {
      await inp.uploadFile(...files);
      await sleep(5000); // 平台侧图片上传/转码
    }

    if (copy.title) {
      const ti = await firstSelector(page, p.selectors.title);
      if (ti) await ti.type(copy.title, { delay: 20 });
    }
    const full = copy.body + (tag ? '\n\n' + tag : '');
    const bo = await firstSelector(page, p.selectors.body);
    if (bo) {
      await bo.click();
      await page.keyboard.insertText(full); // contenteditable 里 type() 常被富文本抢焦点
    }
    await snap('prefill');

    let clicked = false;
    if (p.auto_publish) {
      clicked = await clickByText(page, p.selectors.publish_text || ['发布']);
      if (clicked) { await sleep(6000); await snap('published'); }
    }
    return { clicked, page_url: page.url() };
  } finally {
    await browser.close().catch(() => {});
  }
}

// 媒体选材：按平台 media 策略。vres 为 video 渠道预先查到的成片任务（可为 null）。
async function pickMedia(p, rv, vres) {
  const media = { images: [], video: null };
  const policy = p.media || 'image';
  if (policy === 'video') {
    if (vres) media.video = localPath(vres.video);
    return media;
  }
  for (const u of [rv.cover, ...(rv.images || [])]) {
    const lp = localPath(u);
    if (lp && !media.images.includes(lp)) media.images.push(lp);
  }
  return media;
}

// ---- 任务入口（v9 人审闸门）----
// 发布任务必须携带管理小程序里「已放行」的 item_id：
//   ① 文案以放行稿为准（放行后又改的，发布前回读最新稿——直到任务被领取执行前都来得及反悔）；
//   ② 没有 item_id 或状态不是 approved（驳回/待审/不存在）一律 skip，机器没有任何绕审通道；
//   ③ 发布动作完成后回填 item 状态（published/failed），管理端一目了然。
// 凭证没配好时的"发布包"不算发布：item 留在 approved，配好 cookie 后重新点放行即可真发。

async function publish(task, platformName) {
  const p = pub.platform(platformName);
  if (!p) return { status: 'skipped', note: `publishers.json 缺 ${platformName} 段` };

  const itemId = Number(task.payload?.item_id || 0);
  if (!itemId) {
    return { status: 'skipped', note: '未经人审放行（任务没带 item_id），拒发——请到管理小程序「AI 流水线」待审列表放行' };
  }
  const item = await api.getSocialItem(itemId).catch(() => null);
  if (!item) return { status: 'skipped', note: `待审文案 #${itemId} 不存在，拒发` };
  if (item.status !== 'approved') {
    return { status: 'skipped', note: `待审文案 #${itemId} 状态=${item.status}，未放行不发布（人审闸门）` };
  }

  // v10：视频工坊的稿不挂点评（review_id=0），用稿子自身造一份伪内容供下游复用；
  // 普通内容稿照旧回读点评全字段。
  let rv;
  if (task.review_id) {
    rv = (await api.getReview(task.review_id)).review;
  } else {
    rv = {
      id: 0, slug: '', dish: item.title || '视频工坊出品', headline: item.title, body: item.body,
      cover: (item.images || [])[0] || '', images: item.images || [], shop: null, score: 0, price: 0,
    };
  }
  const policy = p.media || 'image';
  const copy = {
    title: String(item.title || ''),
    body: String(item.body || ''),
    tags: (Array.isArray(item.tags) ? item.tags : []).map(String).filter(Boolean),
  };

  // 素材：优先放行稿自带的图/片；视频渠道（抖音）没成片不是失败，是节奏问题——
  // 催产 video 任务（服务端自动去重），带着 item_id 把自己顺延 2h 重队，这轮 skip 不烧重试次数。
  let media = { images: [], video: null };
  if (policy === 'video') {
    media.video = localPath(item.video);
    if (!media.video) {
      const vres = await findVideo(rv.id);
      media.video = vres ? localPath(vres.video) : null;
    }
    if (!media.video) {
      const now = Math.floor(Date.now() / 1000);
      await api.enqueue('video', rv.id).catch(() => {});
      await api.enqueue(platformName, rv.id, now + 2 * 3600, { item_id: itemId }).catch(() => {});
      return { status: 'skipped', note: `${p.label}只发视频：已催产 video 任务，本任务顺延 2h 等片` };
    }
  } else {
    for (const u of item.images || []) {
      const lp = localPath(u);
      if (lp && !media.images.includes(lp)) media.images.push(lp);
    }
    if (!media.images.length) media = await pickMedia(p, rv, null); // 放行稿素材全失效：退回原点评素材
  }

  const logDir = path.join(CFG.uploadsDir, 'social', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const ready = pub.readiness(platformName);
  if (!ready.ok) {
    const pack = writePack(p, rv, copy, media, `待人工搬运（${ready.why}）`);
    return {
      status: 'done',
      note: `#${itemId} 已放行，但${ready.why}——已产发布包，配好后重新点放行即自动发`,
      result: { platform: platformName, item_id: itemId, review_id: rv.id, title: copy.title, pack, published_to: 'manual:pack' },
    };
  }

  let auto;
  try {
    auto = await browserPublish(p, copy, media, rv, logDir, stamp());
  } catch (e) {
    // 浏览器挂了也要保住文案：落发布包 + item 标 failed，再抛给服务端按失败重试。
    const pack = writePack(p, rv, copy, media, '自动发布异常，文案已落盘');
    await api.socialItemResult(itemId, 'failed', pack, String(e.message).slice(0, 200)).catch(() => {});
    throw new Error(String(e.message).slice(0, 400) + `（发布包：/uploads/social/${platformName}/ 见 ${pack}）`);
  }
  const publishedTo = auto.clicked ? `${platformName}:auto` : `${platformName}:prefill`;
  const pack = writePack(p, rv, copy, media, auto.clicked ? '已通过浏览器自动发布' : '已预填，未点发布（auto_publish=false）');
  await api
    .socialItemResult(itemId, 'published', pack, publishedTo)
    .catch((e) => log0(`item #${itemId} 状态回填失败：${e.message}`));
  return {
    status: 'done',
    note: auto.clicked ? `${p.label}已自动发布（#${itemId}），请后台抽查` : `${p.label}已预填并截屏（#${itemId}；auto_publish=true 才会自动点发布）`,
    result: {
      platform: platformName, item_id: itemId, review_id: rv.id, title: copy.title, pack,
      page_url: auto.page_url, published_to: publishedTo,
      logs: '/uploads/social/logs/',
    },
  };
}

function log0(msg) { console.log(new Date().toISOString(), msg); }

module.exports = { publish, genCopy, findVideo, pickMedia, tagLine, localPath };
