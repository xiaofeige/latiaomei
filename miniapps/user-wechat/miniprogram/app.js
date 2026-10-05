// 全局：启动拉一次公开配置（订阅模板/站长人设），静默登录不阻塞首屏。
const config = require('./config');
const api = require('./utils/request');
const auth = require('./utils/auth');

App({
  globalData: {
    cfg: null,      // /api/mp/config：sub_templates、ip_name…
    tiers: [],      // 五档徽章元数据（来自 bootstrap，detail/list 共用）
  },
  onLaunch() {
    api.get('/mp/config', {}, { silent: true })
      .then((d) => { this.globalData.cfg = d; })
      .catch(() => {});
    // 静默登录拿订阅配额用的小令牌；失败不影响看内容（内容接口匿名）
    auth.ensureLogin().catch(() => {});
  },
  // 详情页分享出去要能直达，统一从这里出口
  sharePath(review) {
    return '/pages/detail/detail?slug=' + review.slug;
  },
});
