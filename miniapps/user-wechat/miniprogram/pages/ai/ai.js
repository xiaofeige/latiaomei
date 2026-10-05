// 辣条妹 · 吃货 AI 大脑（v11 默认首页）。
// 生成式 UI：服务端回 blocks（text/ask/shops/plan/tips/actions/verdict），这里逐块渲染成控件。
// verdict = 鉴店判决书：店靠不靠谱/会不会翻车，附四平台风评 + 高德扫街榜。
// LLM 挂了服务端会自动兜底，端上永远有内容；再失败就本地给转盘引导，绝不白屏。
const api = require('../../utils/request');
const geo = require('../../utils/geo');
const speech = require('../../utils/speech');
const { absUrl } = require('../../utils/format');

const HIST_KEY = 'ai_hist_v2';
const PREFS_KEY = 'ai_prefs_v1';
const LOC_KEY = 'ai_loc_v1';
const LOC_TTL = 30 * 60 * 1000; // 半小时内的定位继续用，不反复弹权限

const QUICKS = [
  { e: '🗓', t: '帮我把来杭州的每一餐安排好', d: '几天几餐，顿顿不落' },
  { e: '📍', t: '我现在附近有什么好吃的', d: '按你的位置挑严选' },
  { e: '🔍', t: '网红店靠谱吗？帮我鉴店防翻车', d: '查刷单水分·看高德扫街榜' },
  { e: '🥗', t: '想吃得健康点，别太难吃', d: '减脂也要落胃' },
  { e: '🍢', t: '今天想安排一顿放纵餐', d: '一周就造这一次' },
];

const SPICY_OPTS = [
  { v: 0, l: '滴辣不沾' }, { v: 1, l: '微辣就好' }, { v: 2, l: '能吃辣' }, { v: 3, l: '无辣不欢' },
];
const BUDGET_OPTS = [
  { v: 0, l: '不限' }, { v: 30, l: '¥30 省着恰' }, { v: 60, l: '¥60 舒服' }, { v: 100, l: '¥100 犒劳' },
];
const GOAL_OPTS = [
  { v: 'slim', l: '减脂别亏嘴' }, { v: 'keep', l: '健康维持' }, { v: 'stingy', l: '省钱续命' }, { v: 'thrill', l: '就要放纵' },
];

// verdict 判决等级 → 徽章文案（跟服务端 sanitizeVerdict 的枚举对齐）
const VERDICT_LAB = { solid: '靠谱', foggy: '有水分', bust: '翻车预警', unknown: '没底细' };

let SEQ = Date.now() % 1e9;
const nid = () => ++SEQ;

/* ---------- 渲染层小工具 ---------- */

// 极简 markdown：按行拆，**词** 变粗体段。返回 [{runs:[{t,b}]}]
function parseMd(md) {
  return String(md || '').split('\n').filter((s) => s.trim() !== '' || false).map((line) => {
    const runs = [];
    const parts = line.split('**');
    parts.forEach((p, i) => {
      if (p) runs.push({ t: p, b: i % 2 === 1 });
    });
    if (!runs.length) runs.push({ t: line || ' ', b: false });
    return { runs };
  });
}

// 服务端 block → 端上可渲染 block（补 UI 字段）
function normBlock(b) {
  const o = Object.assign({}, b);
  switch (b.type) {
    case 'text':
      o._lines = parseMd(b.md);
      break;
    case 'verdict':
      o._lab = VERDICT_LAB[b.level] || '未鉴';
      o.signals = b.signals || [];
      o.platforms = b.platforms || [];
      break;
    case 'ask':
      o._sel = (b.options || []).map(() => 0);
      break;
    case 'shops':
      o.items = (b.items || []).map(hydrateShop);
      break;
    case 'plan':
      o.days = (b.days || []).map((d) => ({
        day: d.day, label: d.label,
        meals: (d.meals || []).map((m) => Object.assign({}, m, m.shop ? { shop: hydrateShop(m.shop) } : {})),
      }));
      break;
    case 'tips':
      o.items = (b.items || []).map((s) => ({ t: s }));
      break;
  }
  return o;
}

function hydrateShop(s) {
  return Object.assign({}, s, { _cover: absUrl(s.cover) });
}

// ai 回答压成纯文本，作为回传给 LLM 的对话历史
function plainOf(ans) {
  const bits = [];
  (ans.blocks || []).forEach((b) => {
    if (b.type === 'text') bits.push(b.md);
    else if (b.type === 'ask') bits.push('[问了: ' + b.q + ']');
    else if (b.type === 'shops') bits.push('推荐: ' + (b.items || []).map((i) => i.dish + '@' + (i.shop || '')).join('、'));
    else if (b.type === 'plan') bits.push('规划: ' + (b.days || []).map((d) => d.label + ' ' + d.meals.map((m) => m.slot + m.title).join('·')).join(' | '));
    else if (b.type === 'tips') bits.push((b.title || '贴士') + ': ' + (b.items || []).join('；'));
    else if (b.type === 'verdict') bits.push('鉴店判决[' + (VERDICT_LAB[b.level] || b.level) + ']: ' + b.shop + ' — ' + (b.judge || ''));
    else if (b.type === 'actions') bits.push('按钮: ' + (b.items || []).map((a) => a.label).join('、'));
  });
  return bits.join('\n') || '（收到）';
}

Page({
  data: {
    msgs: [], // {id, role:'me'|'ai', text | thinking/blocks/chips, load, bad}
    input: '',
    busy: false,
    loc: null,           // {lat,lng}
    locOn: false,
    quicks: QUICKS,
    prefs: null,         // 已存档案（发送用）
    showPrefs: false,
    draft: null,         // 面板编辑中的副本
    spicyOpts: SPICY_OPTS, budgetOpts: BUDGET_OPTS, goalOpts: GOAL_OPTS,
    lastId: 0,
    speechOn: false,   // 语音插件可用才显示话筒
    recording: false,  // 按住说话中
    recText: '',       // 实时转写
    padH: 0,           // 消息流底部让位高度（px）：= 吸底输入条实际吃掉的空间，运行时量出来
  },

  onLoad() {
    this._pending = null;
    this.setData({ speechOn: speech.available() });
    this.restore();
    this.loadLoc();
  },

  onReady() { this.measurePad(); },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setActive('ai');
    }
  },

  onHide() { if (this.data.recording) speech.stopHold(); },
  onUnload() { if (this.data.recording) speech.stopHold(); },

  /* ---------- 分享：刚聊出来的计划/严选/鉴店判决，直接右上角转给搭子 ---------- */

  // 根据最近一条有分享价值的回答拼卡片标题；没聊过就用人设文案
  shareTitle() {
    const msgs = this.data.msgs || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'ai' || m.load || m.bad) continue;
      const blks = m.blocks || [];
      const plan = blks.filter((b) => b.type === 'plan')[0];
      if (plan) {
        const n = (plan.days || []).length;
        return '辣条妹排好的杭州' + (n ? n + '天' : '') + '干饭计划，照着恰不踩雷 🗓';
      }
      const shops = blks.filter((b) => b.type === 'shops')[0];
      if (shops && (shops.items || []).length) {
        const names = shops.items.slice(0, 2)
          .map((s) => s.dish || s.shop).filter(Boolean).join('、');
        return '辣条妹严选：' + names + '…杭州只恰真的 🌶';
      }
      const vrd = blks.filter((b) => b.type === 'verdict')[0];
      if (vrd) return '网红店' + (vrd.shop || '') + '靠谱吗？辣条妹判：' + (vrd._lab || '看细') + ' 🔍';
      break;
    }
    return '辣条妹 · 在杭州吃了十年，你的每一餐帮你安排明白 🌶';
  },

  onShareAppMessage() {
    return { title: this.shareTitle(), path: '/pages/ai/ai' };
  },

  onShareTimeline() {
    return { title: this.shareTitle() };
  },

  tapReset() {
    if (!this.data.msgs.length) {
      // 按钮常驻，空会话时给个反馈，以前提醒会让人以为“新会话按钮没了”
      wx.showToast({ title: '这一页是新的，直接问就行 🌶', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '和辣条妹重开一局？', content: '聊天记录会清掉，口味档案和定位留着。',
      confirmText: '重开', cancelText: '再聊聊',
      success: (r) => { if (r.confirm) this.clearChat(); },
    });
  },

  /* ---------- 历史 / 偏好 / 定位 存取 ---------- */

  restore() {
    let prefs = null; let hist = null;
    try { prefs = wx.getStorageSync(PREFS_KEY) || null; } catch (e) {}
    try { hist = wx.getStorageSync(HIST_KEY) || null; } catch (e) {}
    const msgs = [];
    (Array.isArray(hist) ? hist : []).forEach((h) => {
      if (h.role === 'me') msgs.push({ id: nid(), role: 'me', text: h.text });
      else if (h.role === 'ai' && h.ans) {
        msgs.push({
          id: nid(), role: 'ai',
          thinking: h.ans.thinking || '',
          _thOpen: false,
          blocks: (h.ans.blocks || []).map(normBlock),
          chips: h.ans.chips || [],
          plain: plainOf(h.ans),
        });
      }
    });
    this.setData({ msgs, prefs, lastId: msgs.length ? msgs[msgs.length - 1].id : 0 });
  },

  persist() {
    const out = [];
    this.data.msgs.forEach((m) => {
      if (m.load || m.bad) return;
      if (m.role === 'me') out.push({ role: 'me', text: m.text });
      else out.push({ role: 'ai', ans: { thinking: m.thinking, blocks: (m.blocks || []).map((b) => stripUi(b)) } });
    });
    try { wx.setStorageSync(HIST_KEY, out.slice(-30)); } catch (e) {}
  },

  clearChat() {
    try { wx.removeStorageSync(HIST_KEY); } catch (e) {}
    this.setData({ msgs: [], busy: false });
  },

  loadLoc() {
    let loc = null;
    try { loc = wx.getStorageSync(LOC_KEY); } catch (e) {}
    if (loc && loc.ts && Date.now() - loc.ts < LOC_TTL) {
      this.setData({ loc, locOn: true });
      return;
    }
    // 已授权过就静默拿一次，不打扰
    wx.getSetting({
      success: (r) => {
        if (r.authSetting && r.authSetting['scope.userLocation']) this.locate(true);
      },
    });
  },

  tapLoc() {
    if (this.data.locOn) { this.locate(false); return; }
    this.locate(false);
  },

  locate(silent) {
    if (this._locBusy) return;
    this._locBusy = true;
    geo.locate().then((p) => {
      this._locBusy = false;
      const loc = { lat: p.lat, lng: p.lng, ts: Date.now() };
      try { wx.setStorageSync(LOC_KEY, loc); } catch (e) {}
      this.setData({ loc, locOn: true });
      if (!silent) wx.showToast({ title: '拿到了，先紧着你附近的推', icon: 'none' });
    }).catch((e) => {
      this._locBusy = false;
      const denied = e && /deny|denied|auth/i.test(e.errMsg || '');
      if (denied && !silent) {
        wx.showModal({
          title: '定位没拿到', content: '不开定位也行，辣条妹按杭州全市给你推。要开的话去设置里允许。',
          confirmText: '去设置', cancelText: '不用了',
          success: (r) => { if (r.confirm) wx.openSetting(); },
        });
      } else if (!silent) {
        wx.showToast({ title: '定位失败，按全市推', icon: 'none' });
      }
    });
  },

  /* ---------- 口味档案 ---------- */

  openPrefs() {
    const p = this.data.prefs || {};
    const draft = Object.assign({
      spicy: 2, hometown: '', taboo: '', budget: 0, goal: '', days: 0, text: '',
    }, p);
    this.setData({ showPrefs: true, draft });
  },
  closePrefs() { this.setData({ showPrefs: false, draft: null }); },
  noop() {},

  dSet(e) { // draft 字段通用写入：data-k="hometown"
    const k = e.currentTarget.dataset.k;
    this.setData({ ['draft.' + k]: e.detail.value !== undefined ? e.detail.value : e.detail });
  },
  dPick(e) { // data-k="spicy" data-v="1"
    const k = e.currentTarget.dataset.k;
    let v = e.currentTarget.dataset.v;
    if (k === 'spicy' || k === 'budget' || k === 'days') v = Number(v);
    const cur = this.data.draft[k];
    this.setData({ ['draft.' + k]: cur === v ? (k === 'spicy' ? 2 : '') : v });
  },
  dDays(e) {
    const d = Number(e.currentTarget.dataset.d);
    const v = Math.min(7, Math.max(0, (this.data.draft.days || 0) + d));
    this.setData({ 'draft.days': v });
  },
  savePrefs() {
    const p = Object.assign({}, this.data.draft);
    if (typeof p.hometown === 'number') p.hometown = String(p.hometown);
    try { wx.setStorageSync(PREFS_KEY, p); } catch (e) {}
    this.setData({ prefs: p, showPrefs: false });
    wx.showToast({ title: '档案存好了，辣条妹心里有数了', icon: 'none' });
  },

  /* ---------- 对话 ---------- */

  onInput(e) { this.setData({ input: e.detail.value }); this.measurePad(); },

  /* ---------- 吸底输入条让位 ----------
     输入框是多行自适应的，长高之后固定 340rpx 的底部空垫就不够，最后一条内容会被输入框
     盖住、往上滑也滑不出来。所以直接量出输入条顶沿到视口底部的距离（= 它吃掉的空间，
     含 tab bar 让位），写进 padH 当消息流的底部预留高。键盘弹起时页面被整体上推，
     量到的是假值，先跳过，收起键盘后再量一次。 */
  winH() {
    try {
      const w = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
      return w.windowHeight || w.screenHeight || 0;
    } catch (e) { return 0; }
  },

  measurePad() {
    if (this._padT) clearTimeout(this._padT);
    this._padT = setTimeout(() => {
      this._padT = null;
      if (this._kbUp) return;              // 键盘开着：等收起后再量
      const h = this.winH();
      if (!h) return;
      wx.createSelectorQuery().select('.ibar').boundingClientRect((r) => {
        if (!r || typeof r.top !== 'number' || !r.height) return;
        const need = Math.max(0, Math.round(h - r.top + 16)); // +16px 呼吸位
        if (Math.abs(need - (this.data.padH || 0)) > 4) this.setData({ padH: need });
      }).exec();
    }, 150);
  },

  onLineChange() { this.measurePad(); },

  // 键盘/聚焦/失焦都走这里：失焦后必须重量一次
  onKbChange(e) {
    const hh = (e && e.detail && e.detail.height) || 0;
    this._kbUp = hh > 0;
    if (!this._kbUp) this.measurePad();
  },

  /* ---------- 语音输入：按住话筒说话，松手把文字填进输入框 ---------- */

  voiceStart() {
    if (this.data.recording) return;
    if (!speech.available()) {
      this.setData({ speechOn: false });
      return;
    }
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    this._voiceBefore = this.data.input || '';
    this.setData({ recording: true, recText: '' });
    speech.startHold({
      onInterim: (t) => this.setData({ recText: t }),
      onFinal: (t) => {
        this.setData({ recording: false, recText: '' });
        const text = String(t || '').trim();
        if (!text) {
          wx.showToast({ title: '没听到话，按住再说长一点', icon: 'none' });
          return;
        }
        wx.vibrateShort && wx.vibrateShort({ type: 'light' });
        const before = this._voiceBefore || '';
        this.setData({ input: (before && !/\s$/.test(before) ? before + ' ' : before) + text });
      },
      onError: (msg) => {
        this.setData({ recording: false, recText: '' });
        wx.showToast({ title: msg, icon: 'none', duration: 2800 });
      },
    });
  },

  voiceEnd() {
    if (!this.data.recording) return;
    speech.stopHold();
  },

  tapQuick(e) {
    this.send(this.data.quicks[e.currentTarget.dataset.i].t);
  },
  tapChip(e) {
    this.send(e.currentTarget.dataset.q);
  },

  goWheel() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  sendText() {
    const t = (this.data.input || '').trim();
    if (!t) return;
    this.send(t);
  },

  send(text) {
    if (this.data.busy || !text) return;
    const me = { id: nid(), role: 'me', text };
    const ai = { id: nid(), role: 'ai', load: true };
    const msgs = this.data.msgs.concat([me, ai]);
    this.setData({ msgs, busy: true, input: '', lastId: ai.id });
    this.toBottom(ai.id);
    this.ask(msgs, me, ai);
  },

  ask(msgs, me, ai) {
    const payload = {
      messages: this.payloadOf(msgs, ai.id),
      prefs: this.data.prefs || {},
    };
    if (this.data.loc) {
      payload.loc = { lat: this.data.loc.lat, lng: this.data.loc.lng, name: '用户当前位置' };
    }
    this._retry = { me, ai, payload };
    api.post('/mp/agent/chat', payload, { silent: true, timeout: 65000 })
      .then((d) => this.renderAnswer(ai.id, d))
      .catch((e) => this.renderError(ai.id, me, e));
  },

  payloadOf(msgs, untilId) {
    const out = [];
    for (const m of msgs) {
      if (m.id === untilId) break;
      if (m.load || m.bad) continue;
      if (m.role === 'me') out.push({ role: 'user', content: m.text });
      else if (m.plain) out.push({ role: 'assistant', content: m.plain });
    }
    return out.slice(-12);
  },

  renderAnswer(id, d) {
    const blocks = (d.blocks || []).map(normBlock);
    const idx = this.data.msgs.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const ans = {
      thinking: d.thinking || '',
      _thOpen: false,
      blocks: blocks.length ? blocks : [{ type: 'text', md: '（这波我没接住，你再问一句？）', _lines: parseMd('（这波我没接住，你再问一句？）') }],
      chips: d.chips || [],
      plain: plainOf(d),
    };
    this.setData({
      [`msgs[${idx}].load`]: false,
      [`msgs[${idx}].thinking`]: ans.thinking,
      [`msgs[${idx}].blocks`]: ans.blocks,
      [`msgs[${idx}].chips`]: ans.chips,
      [`msgs[${idx}].plain`]: ans.plain,
      busy: false,
    });
    this.persist();
    this.toBottom(id);
  },

  renderError(id, me, e) {
    const idx = this.data.msgs.findIndex((m) => m.id === id);
    if (idx < 0) return;
    this.setData({
      [`msgs[${idx}].load`]: false,
      [`msgs[${idx}].bad`]: true,
      [`msgs[${idx}].err`]: (e && e.message) || '网络开小差了',
      busy: false,
    });
  },

  retry(e) {
    const id = e.currentTarget.dataset.id;
    const idx = this.data.msgs.findIndex((m) => m.id === id);
    if (idx < 0 || !this._retry) return;
    const ai = this.data.msgs[idx];
    this.setData({ [`msgs[${idx}].load`]: true, [`msgs[${idx}].bad`]: false, [`msgs[${idx}].err`]: '', busy: true });
    api.post('/mp/agent/chat', this._retry.payload, { silent: true, timeout: 65000 })
      .then((d) => this.renderAnswer(ai.id, d))
      .catch((er) => this.renderError(ai.id, this._retry.me, er));
  },

  /* ---------- ask 块交互 ---------- */

  tapOption(e) {
    const { mi, bi, oi } = e.currentTarget.dataset;
    const msg = this.data.msgs[mi];
    if (!msg || msg.load) return;
    const blk = msg.blocks[bi];
    if (!blk) return;
    const sel = blk._sel.slice();
    if (blk.multi) {
      sel[oi] = sel[oi] ? 0 : 1;
    } else {
      const on = sel[oi] ? 0 : 1;
      for (let i = 0; i < sel.length; i++) sel[i] = 0;
      sel[oi] = on;
    }
    this.setData({ [`msgs[${mi}].blocks[${bi}]._sel`]: sel });
  },

  submitAsk(e) {
    const { mi, bi } = e.currentTarget.dataset;
    const msg = this.data.msgs[mi];
    if (!msg) return;
    const blk = msg.blocks[bi];
    const picks = (blk.options || []).filter((o, i) => blk._sel[i]).map((o) => o.label);
    if (!picks.length) {
      wx.showToast({ title: '先挑一个，辣条妹才好下手', icon: 'none' });
      return;
    }
    this.send(picks.join('，'));
  },

  tapAction(e) {
    const { kind, value } = e.currentTarget.dataset;
    if (kind === 'tab') {
      wx.switchTab({ url: value });
    } else {
      this.send(value);
    }
  },

  tapShop(e) {
    const slug = e.currentTarget.dataset.slug;
    if (slug) wx.navigateTo({ url: '/pages/detail/detail?slug=' + encodeURIComponent(slug) });
  },

  toggleThink(e) {
    const mi = e.currentTarget.dataset.mi;
    const msg = this.data.msgs[mi];
    this.setData({ [`msgs[${mi}]._thOpen`]: !msg._thOpen });
  },

  toBottom(id) {
    this.measurePad();
    setTimeout(() => wx.pageScrollTo({ selector: `#m-${id}`, duration: 250 }), 80);
    setTimeout(() => wx.pageScrollTo({ scrollTop: 999999, duration: 300 }), 450);
    // 图/卡片在回复里是异步出高度的，晚点再滚一次，确保最后一条完整落在输入框上方
    setTimeout(() => wx.pageScrollTo({ scrollTop: 999999, duration: 200 }), 900);
  },
});

// 存储前剥掉端上 UI 字段
function stripUi(b) {
  const o = Object.assign({}, b);
  delete o._lines; delete o._sel; delete o._cover; delete o._lab;
  if (o.items && b.type === 'shops') o.items = o.items.map((i) => { const x = Object.assign({}, i); delete x._cover; return x; });
  if (o.days && b.type === 'plan') {
    o.days = o.days.map((d) => ({
      day: d.day, label: d.label,
      meals: (d.meals || []).map((m) => {
        const x = Object.assign({}, m);
        if (x.shop) { x.shop = Object.assign({}, x.shop); delete x.shop._cover; }
        return x;
      }),
    }));
  }
  return o;
}
