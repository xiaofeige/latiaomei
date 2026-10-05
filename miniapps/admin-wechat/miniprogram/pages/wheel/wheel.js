// 转盘管理：对应首页的两个转盘——御膳房盘转自家菜谱，探店盘转踩过的店。
// 口径跟 web/js/pages.js 的 wheelPool 一致：已发布 + wheel=1 进盘；
// 整盘关光时前台会退回"全部已发布"兜底，所以这里全下盘也不会把转盘弄没。
const api = require('../../utils/api');
const session = require('../../utils/session');

const PANELS = [
  { kind: 'yushanfang', name: '🍳 私厨盘', q: '今天家里做什么', sort: 'new' },
  { kind: 'tandian', name: '🌶 探店盘', q: '今天出去吃什么', sort: 'hot' },
];

Page({
  data: {
    canWrite: false,
    tab: 0,
    panels: [],
    loading: false,
  },

  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.load();
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  load() {
    this.setData({ loading: true });
    return Promise.all(PANELS.map((p) => api.listReviews({
      status: 'published', kind: p.kind, sort: p.sort, page: 1, size: 100,
    }).catch(() => null))).then((pages) => {
      const panels = PANELS.map((p, i) => {
        const d = pages[i] || { items: [], total: 0 };
        const items = (d.items || []).map((it) => ({
          id: it.id, dish: it.dish, slug: it.slug, wheel: !!it.wheel,
          shop: it.shop ? it.shop.name : '', view_count: it.view_count,
        }));
        const on = items.filter((x) => x.wheel).length;
        return { ...p, items, on, off: items.length - on, total: d.total || 0 };
      });
      this.setData({ panels, loading: false });
    }).catch(() => this.setData({ loading: false }));
  },

  switchTab(e) {
    this.setData({ tab: Number(e.currentTarget.dataset.i) });
  },

  toggle(e) {
    const { id, on } = e.currentTarget.dataset;
    api.setWheel(Number(id), !on).then(() => {
      wx.showToast({ title: on ? '已下盘' : '已上盘', icon: 'success' });
      this.load();
    }).catch(() => {});
  },

  edit(e) {
    wx.navigateTo({ url: `/pages/review-edit/review-edit?id=${e.currentTarget.dataset.id}` });
  },

  create(e) {
    const kind = PANELS[e.currentTarget.dataset.i].kind;
    wx.navigateTo({ url: '/pages/review-edit/review-edit?kind=' + kind });
  },
});
