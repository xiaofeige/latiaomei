// 我的：订阅管理 + 站长人设 + 各端入口。用户端不给任何写权限，纯展示 + 订阅记账。
// 人设/外链数据取自 /api/bootstrap 的 site（/mp/config 只有订阅模板等少量字段）。
const api = require('../../utils/request');
const { absUrl } = require('../../utils/format');
const subscribe = require('../../utils/subscribe');
const auth = require('../../utils/auth');

Page({
  data: { cfg: {}, site: {}, avatar: '', counters: {}, canSub: false, subbed: false, loading: true },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setActive('my');
    this.refresh();
  },

  refresh() {
    const mpCfg = getApp().globalData.cfg || {};
    this.setData({
      canSub: !!(mpCfg.sub_templates && mpCfg.sub_templates.length),
      subbed: !!wx.getStorageSync('mp_subbed'),
    });
    auth.ensureLogin().catch(() => {});
    return api.get('/bootstrap', {}, { silent: true }).then((d) => {
      const site = d.site || {};
      this.setData({
        site,
        counters: d.counters || {},
        avatar: site.ip_avatar ? absUrl(site.ip_avatar) : '',
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },

  async doSub() {
    const r = await subscribe.requestSubscribe();
    if (r.granted) {
      wx.setStorageSync('mp_subbed', true);
      this.setData({ subbed: true });
      wx.showToast({ title: '订上了，开饭喊你', icon: 'none' });
    } else if (r.reason === 'not configured') {
      wx.showToast({ title: '推送还没开放，先逛榜', icon: 'none' });
    }
  },

  toRank() { wx.switchTab({ url: '/pages/list/list' }); },

  toWish() { wx.switchTab({ url: '/pages/wish/wish' }); },

  toHome() { wx.switchTab({ url: '/pages/index/index' }); },

  copyDouyin() {
    const u = this.data.site.douyin_url;
    if (!u) return wx.showToast({ title: '抖音号还没绑', icon: 'none' });
    wx.setClipboardData({ data: u, success: () => wx.showToast({ title: '已复制，去抖音粘贴', icon: 'none' }) });
  },

  // 分享就是递名片：把「杭州美食第一人」四个字递出去
  onShareAppMessage() {
    const c = this.data.counters || {};
    return {
      title: '杭州恰饭第一人辣条妹的简历：' + (c.reviews || c.published || 0) + ' 道判决，零恰饭造假',
      path: '/pages/index/index',
    };
  },
  onShareTimeline() {
    return { title: '辣条妹 · 10年只恰真的，句句判决书' };
  },
});
