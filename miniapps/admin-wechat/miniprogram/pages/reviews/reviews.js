// 私厨榜（御膳房）：她自己的菜谱排行榜。列表/拖拽/录入逻辑都在 rank-admin 组件里。
const share = require('../../utils/share');

Page({
  onShareAppMessage() { return share.msg('/pages/reviews/reviews'); },
  onShareTimeline() { return share.timeline(); },
});
