// 店铺档案：店况 + 这家店被辣条妹判过的全部菜。
const api = require('../../utils/request');
const { absUrl } = require('../../utils/format');

Page({
  data: { loading: true, shop: null, reviews: [], tiers: [] },

  onLoad(q) { this.slug = q.slug; this.fetch(); },

  fetch() {
    return api.get('/shops/' + encodeURIComponent(this.slug)).then((d) => {
      const s = d.shop;
      this.setData({
        loading: false,
        tiers: getApp().globalData.tiers,
        shop: {
          name: s.name, city: s.city, district: s.district, address: s.address,
          cuisine: s.cuisine, avgPrice: s.avg_price > 0 ? '人均 ¥' + s.avg_price : '',
          hours: s.hours, cover: absUrl(s.cover), note: s.note, bestDish: s.best_dish,
          hangCnt: s.hang_count || 0, laCnt: s.la_count || 0,
          avgScore: s.avg_score ? s.avg_score.toFixed(1) : '—',
          douyinUrl: s.douyin_url || '', xhsUrl: s.xhs_url || '',
        },
        reviews: (d.reviews && d.reviews.items) || [],
      });
      wx.setNavigationBarTitle({ title: s.name });
    }).catch(() => this.setData({ loading: false }));
  },

  // 抖音链接：小程序打不开外部短视频 app 链接，复制引导去抖音粘贴
  copyDouyin() {
    const u = (this.data.shop && this.data.shop.douyinUrl) || '';
    if (!u) return;
    wx.setClipboardData({
      data: u,
      success: () => wx.showToast({ title: '链接已复制，去抖音粘贴打开', icon: 'none', duration: 2600 }),
    });
  },

  onShareAppMessage() {
    const s = this.data.shop;
    return s ? {
      title: '这家店被辣条妹翻了个底朝天：' + s.hangCnt + ' 道夯 ' + s.laCnt + ' 道拉，成绩单在这',
      path: '/pages/shop/shop?slug=' + this.slug,
    } : { title: '辣条妹的御膳房', path: '/pages/index/index' };
  },
  onShareTimeline() {
    const s = this.data.shop;
    return { title: s ? s.name + ' · 辣条妹店铺档案' : '辣条妹的店铺档案', query: 'slug=' + (s ? s.slug : '') };
  },
});
