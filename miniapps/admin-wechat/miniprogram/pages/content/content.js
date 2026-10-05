// 内容管理（Tab2）：负责"存量内容怎么摆"——探店榜 + 私厨榜（菜单）排序/调分/草稿发布，
// 列表/拖拽/调分逻辑都在 rank-admin 组件；"新内容怎么生产"在工作台 Tab3，状态监控在概览 Tab1。
// 概览页跳转带意图：globalData.contentKind 预选榜；globalData.rankDraft={kind} 让组件直接开在草稿箱。
const share = require('../../utils/share');

Page({
  data: {
    kind: 'tandian',
    segH: 44, // 分段条实际高度（px），onReady 里量一次
  },

  onShow() {
    const g = getApp().globalData || {};
    if (g.contentKind && g.contentKind !== this.data.kind) {
      this.setData({ kind: g.contentKind });
    }
    g.contentKind = null;
  },

  onReady() {
    this.createSelectorQuery().select('.ct-seg').boundingClientRect((r) => {
      if (r && r.height) this.setData({ segH: Math.round(r.height) });
    }).exec();
  },

  switchKind(e) {
    const k = e.currentTarget.dataset.k;
    if (k !== this.data.kind) this.setData({ kind: k });
  },

  onShareAppMessage() { return share.msg('/pages/content/content'); },
  onShareTimeline() { return share.timeline(); },
});
