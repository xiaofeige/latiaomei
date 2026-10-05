// 探店榜：出去踩店的排行榜。列表/拖拽/录入逻辑都在 rank-admin 组件里。
const share = require('../../utils/share');

Page({
  onShareAppMessage() { return share.msg('/pages/shops/shops'); },
  onShareTimeline() { return share.timeline(); },
});
