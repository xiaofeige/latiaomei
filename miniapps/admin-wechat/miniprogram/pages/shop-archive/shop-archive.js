// 店铺档案管理（从探店 Tab 挪进来的二级页）。删除会连带影响点评，故弹确认。
const fmt = require('../../utils/format');
const api = require('../../utils/api');
const session = require('../../utils/session');

const SIZE = 30;

Page({
  onShareAppMessage() { return require('../../utils/share').msg('/pages/shop-archive/shop-archive'); },
  onShareTimeline() { return require('../../utils/share').timeline(); },

  data: {
    q: '', city: '', sort: 'new',
    sortTabs: [
      { v: 'new', t: '最新' }, { v: 'name', t: '名称' }, { v: 'price', t: '人均' },
    ],
    items: [], page: 1, hasMore: false, loading: false, canWrite: false,
  },

  onShow() { this.setData({ canWrite: session.canWrite() }); this.refresh(); },
  onPullDownRefresh() { this.refresh().then(() => wx.stopPullDownRefresh()); },

  refresh() { this.setData({ items: [], page: 1 }); return this.load(1); },

  load(page) {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });
    return api.listShops({ q: this.data.q, city: this.data.city, sort: this.data.sort, page, size: SIZE })
      .then((d) => {
        const items = (d.items || []).map((s) => ({ ...s, _cover: fmt.fullUrl(s.cover) }));
        this.setData({
          items: page === 1 ? items : this.data.items.concat(items),
          page, hasMore: !!d.has_more, loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  onReachBottom() { if (this.data.hasMore) this.load(this.data.page + 1); },
  onQ(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.refresh(); },
  onClear() { this.setData({ q: '' }); this.refresh(); },
  onSort(e) { this.setData({ sort: e.currentTarget.dataset.v }); this.refresh(); },

  // 后台没有单店详情接口，把列表里已有的这条直接交给编辑页，避开再查一次。
  edit(e) {
    const id = e.currentTarget.dataset.id;
    const hit = this.data.items.filter((s) => s.id === id)[0];
    if (hit) wx.setStorageSync('latiaomei_editing_shop', hit);
    wx.navigateTo({ url: `/pages/shop-edit/shop-edit?id=${id}` });
  },
  create() { wx.navigateTo({ url: '/pages/shop-edit/shop-edit' }); },

  // 跳到内容 Tab 的探店榜并按店名搜：Tab 页不能带参，用 globalData 递话。
  viewReviews(e) {
    const name = e.currentTarget.dataset.name;
    getApp().globalData = getApp().globalData || {};
    getApp().globalData.rankQuery = { kind: 'tandian', q: name };
    getApp().globalData.contentKind = 'tandian';
    wx.switchTab({ url: '/pages/content/content' });
  },

  remove(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除店铺',
      content: `确定删除「${name}」？已关联该店的点评会变成未关联，需重新指定。`,
      confirmColor: '#a0503c',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteShop(id).then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this.refresh(); }).catch(() => {});
      },
    });
  },
});
