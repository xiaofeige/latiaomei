// 许愿池：粉丝许愿的收口分析页。
// 上半是分析（状态分布 + 近7天新增 + 高频词），下半是按状态筛选的流水。
// 动作：已阅 / 翻牌（一键转指令进指挥中心）/ 已踩坑 / 暂不做，可写批复。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');

const TABS = [
  { code: 'new', label: '待处理' },
  { code: 'read', label: '已阅' },
  { code: 'picked', label: '已翻牌' },
  { code: 'done', label: '已踩坑' },
  { code: 'rejected', label: '暂不做' },
  { code: 'all', label: '全部' },
];
// 每条愿望可点的流转按钮（按角色权限渲染）
const ACTIONS = [
  { to: 'read', label: '已阅' },
  { to: 'picked', label: '翻牌' },
  { to: 'done', label: '踩完' },
  { to: 'rejected', label: '暂不' },
];

Page({
  data: {
    tabs: TABS, actions: ACTIONS,
    tab: 'new',
    stats: {}, keywords: [],
    wishes: [],
    canWrite: false,
    loading: true,
  },

  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.reload();
  },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },

  reload() {
    this.setData({ loading: true });
    return api.wishes({ status: this.data.tab, limit: 100 }).then((d) => {
      const st = d.stats || {};
      const maxKw = (d.stats.keywords || []).reduce((m, k) => Math.max(m, k.count), 1);
      this.setData({
        loading: false,
        stats: st,
        keywords: (st.keywords || []).map((k) => ({
          ...k, hot: k.count / maxKw >= 0.6 ? 'hot' : k.count / maxKw >= 0.3 ? 'mid' : '',
        })),
        wishes: (d.wishes || []).map((w) => ({ ...w, timeTxt: fmt.ago(w.created_at) })),
      });
    }).catch(() => this.setData({ loading: false }));
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.code }, () => this.reload());
  },

  // 状态流转：先弹批复（可留空），picked 走"转指令"另说
  act(e) {
    const { id, to } = e.currentTarget.dataset;
    wx.showModal({
      title: '批复（选填）',
      editable: true,
      placeholderText: to === 'picked' ? '想对许愿人说什么？' : '处理说明，用户端可见',
      success: (r) => {
        if (!r.confirm) return;
        api.wishStatus(id, to, (r.content || '').trim()).then(() => {
          wx.showToast({ title: '已更新', icon: 'success' });
          this.reload();
        }).catch(() => {});
      },
    });
  },

  // 翻牌转指令：许愿直接进指挥中心 topic 队列，worker 按指令产草稿
  toDirective(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '翻牌这条愿望',
      content: '将转成指挥中心指令（topic），AI 草稿队列会自动带上原愿望',
      confirmText: '翻牌',
      success: (r) => {
        if (!r.confirm) return;
        api.wishToDirective(id, '').then(() => {
          wx.showToast({ title: '已翻牌并生成指令', icon: 'success' });
          this.reload();
        }).catch(() => {});
      },
    });
  },

  del(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删掉这条愿望？', content: '垃圾内容才删，正常建议留档做分析', confirmText: '删除',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteWish(id).then(() => this.reload()).catch(() => {});
      },
    });
  },
});
