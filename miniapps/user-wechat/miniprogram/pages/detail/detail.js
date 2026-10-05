// 点评详情：正文 + 判分明细 + 店铺卡 + 相关推荐 + 订阅辣椒。
const api = require('../../utils/request');
const { absUrl, tierOf, score1, priceText } = require('../../utils/format');
const subscribe = require('../../utils/subscribe');

Page({
  data: {
    loading: true, rv: null, view: null, related: [], tiers: [],
    gallery: [], canSub: false, subBusy: false,
  },

  onLoad(q) {
    this.slug = q.slug;
    this.fetch();
  },

  fetch() {
    // 分享直达时 tiers 可能还没拉过，补一次字典
    const pre = getApp().globalData.tiers.length
      ? Promise.resolve(null)
      : api.get('/taxonomy', {}, { silent: true }).catch(() => null);
    return pre.then((tax) => api.get('/reviews/' + encodeURIComponent(this.slug))).then((d) => {
      const app = getApp();
      const tiers = (d.review && d.review.tiers) || app.globalData.tiers
        || (tax && tax.tiers) || [];
      const r = d.review;
      const t = tierOf(tiers, r.tier);
      app.globalData.tiers = tiers;
      this.setData({
        loading: false,
        rv: r,
        tiers,
        related: d.related || [],
        view: {
          cover: absUrl(r.cover),
          score: score1(r.score),
          price: priceText(r.price),
          spicy: r.spicy > 0 ? '🌶'.repeat(Math.min(3, r.spicy)) : '',
          tier: r.tier || 'npc',
          tierLabel: t.label, tierName: t.name, tierColor: t.color, tierDesc: t.desc,
          revisit: r.revisit > 0 ? '回头率 ' + r.revisit + '/5' : '',
          shop: r.shop ? { name: r.shop.name, slug: r.shop.slug, city: r.shop.city, district: r.shop.district } : null,
          tastes: (r.tastes || []).map((x) => x.name),
        },
        gallery: (r.images || []).map(absUrl).filter(Boolean),
      });
      wx.setNavigationBarTitle({ title: r.dish });
      const cfg = app.globalData.cfg;
      this.setData({ canSub: !!(cfg && cfg.sub_templates && cfg.sub_templates.length) });
    }).catch(() => this.setData({ loading: false }));
  },

  preview(e) {
    wx.previewImage({ urls: this.data.gallery, current: e.currentTarget.dataset.src });
  },

  toShop() {
    const s = this.data.view && this.data.view.shop;
    if (s && s.slug) wx.navigateTo({ url: '/pages/shop/shop?slug=' + s.slug });
  },

  async doSub() {
    if (this.data.subBusy) return;
    this.setData({ subBusy: true });
    const r = await subscribe.requestSubscribe();
    this.setData({ subBusy: false });
    if (r.granted) wx.showToast({ title: '订上了，新菜喊你', icon: 'none' });
    else if (r.reason === 'rejected') wx.showToast({ title: '不点允许恰不到热点', icon: 'none' });
  },

  onShareAppMessage() {
    const r = this.data.rv;
    return r ? {
      title: '辣条妹判了：「' + (r.headline || r.dish) + '」，就问你敢不敢恰',
      path: '/pages/detail/detail?slug=' + r.slug,
      imageUrl: this.data.view ? this.data.view.cover : undefined,
    } : { title: '辣条妹的御膳房', path: '/pages/index/index' };
  },
  onShareTimeline() {
    const r = this.data.rv;
    return { title: r ? '辣条妹判决书：' + r.dish : '辣条妹的御膳房', query: 'slug=' + (r ? r.slug : '') };
  },
});
