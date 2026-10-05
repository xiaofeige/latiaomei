// 点评卡片：首页/榜单/详情共用。样式全走全局 .rc + .vc 判决贴纸（app.wxss）。
const { absUrl, tierOf, score1, priceText } = require('../../utils/format');

// 五档判决字：一个字（或俩）最有贴纸感，label 太长就取首字，色板由 .t-xxx 类接管
Component({
  properties: {
    review: { type: Object, value: null },
    tiers: { type: Array, value: [] },
  },
  data: { view: null },
  methods: {
    go() {
      const v = this.data.view;
      if (v && v.slug) wx.navigateTo({ url: '/pages/detail/detail?slug=' + v.slug });
    },
  },
  observers: {
    review(r) {
      if (!r) return this.setData({ view: null });
      const t = tierOf(this.data.tiers, r.tier);
      this.setData({
        view: {
          slug: r.slug,
          dish: r.dish,
          headline: r.headline,
          cover: absUrl(r.cover),
          shop: r.shop ? r.shop.name : '',
          score: score1(r.score),
          price: priceText(r.price),
          tier: r.tier || 'npc',
          tierLabel: t.label,
          tierName: t.name,
        },
      });
    },
  },
});
