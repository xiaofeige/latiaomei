// 榜单：搜索 + 栏目/档位/口味/排序筛选 + 无限翻页。
const api = require('../../utils/request');

const KINDS = [
  { code: 'tandian', label: '探店' },
  { code: 'yushanfang', label: '御膳房' },
];
const SORTS = [
  { code: 'rank', label: '榜单' },
  { code: 'new', label: '最新' },
  { code: 'score', label: '评分' },
  { code: 'price', label: '价格' },
  { code: 'hot', label: '人气' },
];

Page({
  data: {
    kinds: KINDS, sorts: SORTS, tiers: [], tastes: [],
    f: { kind: 'tandian', tier: '', taste: '', sort: 'rank', q: '' },
    items: [], page: 1, total: 0, hasMore: false, loading: true,
  },

  onLoad(q) {
    // 分享/搜索进来可能直接带 query
    if (q.kind) this.setData({ 'f.kind': q.kind });
    if (q.tier) this.setData({ 'f.tier': q.tier });
    if (q.sort) this.setData({ 'f.sort': q.sort });
    // 拉一次字典（档位色板+口味标签），全站共用；档位 chip 用 web 站荧光判决色而非后台深色系
    api.get('/taxonomy', {}, { silent: true }).then((d) => {
      const POP = { hang: '#ffc53d', dingji: '#ffc3d2', renshang: '#cfe6b8', npc: '#a9ded5', la: '#141414' };
      this.setData({
        tiers: (d.tiers || []).map((t) => Object.assign({}, t, { pop: POP[t.code] || t.color })),
        tastes: (d.tastes || []).filter((t) => t.kind !== 'scene'),
      });
    }).catch(() => {});
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setActive('list');
    // 消费首页中转来的筛选意图
    const gq = getApp().globalData.listQuery;
    if (gq !== undefined && gq !== null) {
      const f = { kind: 'tandian', tier: '', taste: '', sort: 'rank', q: '' };
      gq.split('&').forEach((kv) => {
        const [k, v] = kv.split('=');
        if (k in f) f[k] = v;
      });
      this.setData({ f });
      getApp().globalData.listQuery = null;
      this.fetch(1);
    } else if (this.data.items.length === 0) {
      this.fetch(1);
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetch(this.data.page + 1);
  },

  fetch(page) {
    this.setData({ loading: true });
    const f = this.data.f;
    const qs = `?kind=${f.kind || 'all'}&tier=${f.tier}&taste=${f.taste}&sort=${f.sort}&q=${encodeURIComponent(f.q)}&page=${page}&size=20`;
    return api.get('/reviews' + qs).then((d) => {
      const items = page === 1 ? d.items : this.data.items.concat(d.items || []);
      this.setData({ items, page, total: d.total || 0, hasMore: d.has_more, loading: false });
    }).catch(() => this.setData({ loading: false }));
  },

  setKind(e) { this.setData({ 'f.kind': e.currentTarget.dataset.v }); this.fetch(1); },
  setTier(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ 'f.tier': this.data.f.tier === v ? '' : v });
    this.fetch(1);
  },
  setTaste(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ 'f.taste': this.data.f.taste === v ? '' : v });
    this.fetch(1);
  },
  setSort(e) { this.setData({ 'f.sort': e.currentTarget.dataset.v }); this.fetch(1); },

  onSearch(e) {
    this.setData({ 'f.q': (e.detail.value || '').trim() });
    this.fetch(1);
  },

  clearSearch() {
    this.setData({ 'f.q': '' });
    this.fetch(1);
  },

  onShareAppMessage() {
    return {
      title: '杭州美食判决书公开：夯的封神、拉的避雷，辣条妹全替你恰过了',
      path: '/pages/list/list',
    };
  },
  onShareTimeline() {
    return { title: '辣条妹的榜单：只恰真的，难吃照写不误' };
  },
});
