// 首页：转盘主打（今天吃啥子转一下，对齐 web 站双盘玩法），下面 bootstrap 喂满全屏。
const api = require('../../utils/request');
const { tierOf } = require('../../utils/format');
const geo = require('../../utils/geo');
const subscribe = require('../../utils/subscribe');

const app = () => getApp();

// 转盘玩法文案，照搬 web 站 pages.js 的 tips / fortunes / moods
const WHEEL_TIPS = {
  yu: ['她灶上的菜 · 成本透明', '不好吃就自己加料', '比外卖干净，比餐厅便宜', '做坏了也没人扣分'],
  td: ['踩过的才敢推荐', '难吃的照写不误', '转三次还拉就别出门了', '比看评分靠谱'],
};
const MOODS = [
  { e: '🤤', n: '重口', t: '麻辣' }, { e: '😌', n: '养胃', t: '清淡' },
  { e: '🥵', n: '冒烟', t: '酸辣' }, { e: '🍚', n: '续命', t: '面食' },
];
const FORTUNES = [
  (n) => '条总掐指一算：今天该来口「' + n + '」的',
  (n) => '今日运势：宜「' + n + '」，忌嘴硬说随便',
  (n) => '你五行缺「' + n + '」，补一口能续命',
  (n) => '今日宜：「' + n + '」，忌说随便然后再嫌弃',
];

Page({
  data: {
    loading: true, site: {}, featured: null, tiers: [],
    latest: [], avoid: [], yushanfang: [], shops: [],
    counters: {}, canSub: false,
    // 转盘
    wheelTab: 'td', wheelSegs: [], wheelTip: WHEEL_TIPS.td[0],
    moods: MOODS, fortune: { text: '', slug: '' }, dm: [],
    // 探店盘的「附近」模式：开了才要定位；拿不到就默认杭州全市
    geoOn: false, geoBusy: false, geoLabel: '📍 转到你附近的严选店',
  },

  onLoad() { this.fetch(); this.loadWheels(); },
  onPullDownRefresh() { Promise.all([this.fetch(), this.loadWheels()]).finally(() => wx.stopPullDownRefresh()); },

  fetch() {
    return api.get('/bootstrap').then((d) => {
      app().globalData.tiers = d.tiers || [];
      this.setData({
        loading: false,
        site: d.site || {},
        tiers: d.tiers || [],
        counters: d.counters || {},
        featured: d.featured || null,
        latest: d.latest || [],
        avoid: d.avoid || [],
        yushanfang: (d.yushanfang || []).slice(0, 6),
        shops: d.hot_shops ? (d.hot_shops.items || []).slice(0, 6) : [],
        dm: (d.latest || []).slice(0, 6).map((r) => '· ' + r.dish + ' · ' + tierOf(d.tiers, r.tier).label + ' ·'),
      });
      this.refreshCanSub();
      this.rollFortune(d.tastes || []);
    }).catch(() => { this.setData({ loading: false }); });
  },

  /* ---------------- 转盘 ---------------- */
  // 双盘数据：御膳房转「家里做什么」，探店转「出去吃什么」。
  // 先取后台勾选进转盘池的（wheel=1）；整盘都关光了就退回全部已发布，首页不空转。
  loadWheels() {
    const pool = (kind, sort) =>
      api.get('/reviews', { kind, sort, wheel: 1, size: 100 }, { silent: true })
        .then((p) => (p.items && p.items.length ? p
          : api.get('/reviews', { kind, sort, size: 100 }, { silent: true })))
        .catch(() => ({ items: [] }));
    return Promise.all([pool('yushanfang', 'new'), pool('tandian', 'hot')]).then(([yu, td]) => {
      this._yuRaw = yu.items || [];
      this._tdRaw = td.items || [];
      this._yuSegs = this.toSegs(this._yuRaw, true);
      this._tdSegs = this.toSegs(this._tdRaw, false);
      this.setWheelTab(this.data.wheelTab); // 附近模式开着时刷新会按新数据重建盘
    });
  },

  // 点评→扇区：菜名去重、超长截断交给组件；超 12 道均匀抽样，转盘才转得清
  // distOf(km)：附近模式下副标多一行「店名 · 450m」
  toSegs(items, isYu, distOf) {
    const seen = {}, out = [];
    (items || []).forEach((r) => {
      if (!r || !r.dish || seen[r.dish]) return;
      seen[r.dish] = 1;
      let sub;
      if (isYu) {
        sub = r.price > 0 ? '成本 ¥' + r.price + ' / 人份 · 她灶上的' : '她灶上的';
      } else {
        const base = r.shop ? r.shop.name : '街边踩的';
        sub = distOf ? base + ' · ' + geo.kmText(distOf(r)) : base;
      }
      out.push({ label: r.dish, slug: r.slug, tier: r.tier, sub });
    });
    if (out.length > 12) {
      const k = out.length / 12, sampled = [];
      for (let i = 0; i < 12; i++) sampled.push(out[Math.floor(i * k)]);
      return sampled;
    }
    return out;
  },

  // 附近盘：8km → 15km → 全市逐档扩，集齐 6 道就收手；没标坐标的店不参与筛选
  _nearSegs() {
    const pos = this._pos;
    const distOf = (r) => geo.distanceKm(pos.lat, pos.lng, r.shop.lat, r.shop.lng);
    const radii = [8, 15, Infinity];
    for (let i = 0; i < radii.length; i++) {
      const rad = radii[i];
      const items = (this._tdRaw || []).filter((r) => r.shop && r.shop.lat && r.shop.lng && distOf(r) <= rad);
      const segs = this.toSegs(items, false, rad === Infinity ? null : distOf);
      if (segs.length >= 6 || rad === Infinity) return { segs, radius: rad };
    }
    return { segs: [], radius: Infinity };
  },

  setWheelTab(w) {
    const tips = WHEEL_TIPS[w] || WHEEL_TIPS.td;
    const patch = {
      wheelTab: w,
      wheelSegs: (w === 'yu' ? this._yuSegs : this._tdSegs) || [],
      wheelTip: tips[Math.floor(Math.random() * tips.length)],
    };
    // 探店盘且附近模式开着 → 用附近重建；退回全市时提示一声
    if (w === 'td' && this.data.geoOn && this._pos) {
      const near = this._nearSegs();
      patch.wheelSegs = near.segs;
      if (near.radius === Infinity) {
        patch.geoLabel = '📍 附近标了位置的店还不够 · 先转全杭州';
        wx.showToast({ title: '附近严选店太少，先把盘转回全市', icon: 'none' });
      } else {
        patch.geoLabel = '📍 你附近 ' + near.segs.length + ' 道 · ' + near.radius + 'km 内';
      }
    } else if (w === 'td') {
      patch.geoLabel = '📍 转到你附近的严选店';
    }
    this.setData(patch);
  },

  switchWheel(e) { this.setWheelTab(e.currentTarget.dataset.w); },

  // 附近开关：只在用户主动点的时候才要定位；拒绝/失败都安静退回全市模式
  toggleNear() {
    if (this.data.geoBusy) return;
    if (this.data.geoOn) {
      this.setData({ geoOn: false });
      this.setWheelTab('td');
      return;
    }
    const turnOn = () => { this.setData({ geoOn: true }); this.setWheelTab('td'); };
    if (this._pos) return turnOn();
    this.setData({ geoBusy: true, geoLabel: '定位中…' });
    geo.locate().then((pos) => {
      this._pos = pos;
      this.setData({ geoBusy: false });
      turnOn();
    }).catch(() => {
      this.setData({ geoBusy: false, geoLabel: '📍 转到你附近的严选店' });
      wx.showToast({ title: '没拿到定位，默认杭州全市', icon: 'none' });
    });
  },

  // 味觉占卜：后台没配口味标签时用四个默认心情兑底，占卜条不空着
  rollFortune(tastes) {
    const list = (tastes && tastes.length)
      ? tastes.filter((t) => t.kind !== 'scene')
      : [];
    const pool2 = list.length ? list : MOODS.map((m) => ({ name: m.t, slug: '' }));
    const ft = pool2[Math.floor(Math.random() * pool2.length)];
    const say = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    this.setData({ fortune: { text: say(ft.name), slug: ft.slug || '' } });
  },

  // 转到结果卡「就它了 / 偏要恰」：直达点评详情
  onWheelPick(e) {
    const seg = e.detail && e.detail.seg;
    if (seg && seg.slug) wx.navigateTo({ url: '/pages/detail/detail?slug=' + seg.slug });
  },

  // 占卜/心情入口：带口味筛选跳榜单页（同 toList 的 globalData 中转）
  toTaste(e) {
    const t = e.currentTarget.dataset.t || this.data.fortune.slug;
    if (!t) return;
    app().globalData.listQuery = 'taste=' + encodeURIComponent(t) + '&sort=hot';
    wx.switchTab({ url: '/pages/list/list' });
  },

  // 启动时 cfg 可能晚于 bootstrap 到，onShow 再补一次判定
  onShow() {
    this.refreshCanSub();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setActive('index');
  },
  refreshCanSub() {
    const cfg = app().globalData.cfg;
    this.setData({ canSub: !!(cfg && cfg.sub_templates && cfg.sub_templates.length) });
  },

  toList(e) {
    // tabBar 页收不到 query，经 globalData 中转（list 页 onShow 消费后清空）
    app().globalData.listQuery = e.currentTarget.dataset.q || '';
    wx.switchTab({ url: '/pages/list/list' });
  },

  toShop(e) {
    wx.navigateTo({ url: '/pages/shop/shop?slug=' + e.currentTarget.dataset.slug });
  },

  toWish() { wx.switchTab({ url: '/pages/wish/wish' }); },

  // 订阅辣椒：点允许即换一条推送配额
  async doSub() {
    const r = await subscribe.requestSubscribe();
    if (r.granted) wx.showToast({ title: '订阅成功，开饭前喊你', icon: 'none' });
  },

  // 分享卡就是小广告：标题得像是辣条妹本人在朋友圈喊人
  onShareAppMessage() {
    return {
      title: '别刷外卖了！辣条妹的恰饭转盘转到啥你吃啥 🎡',
      path: '/pages/index/index',
    };
  },
  onShareTimeline() {
    return { title: '今天恰什么？转一下就知道 · 辣条妹只恰真的' };
  },
});
