// 订阅消息授权封装：一次弹窗=一条发送配额（微信规则），点"允许"后端记一次数。
// 模板 ID 由服务端 /api/mp/config 下发（后台 settings 里配置），端上不抄硬编码。
const api = require('./request');
const auth = require('./auth');

function templates() {
  const app = getApp();
  return (app.globalData.cfg && app.globalData.cfg.sub_templates) || [];
}

/**
 * 拉起订阅授权。用户点允许后向后端配额 +1。
 * @returns {Promise<{granted:boolean, reason?:string}>}
 */
function requestSubscribe() {
  const ids = templates();
  if (!ids.length) return Promise.resolve({ granted: false, reason: 'not configured' });
  return auth.ensureLogin().then(() => new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmpl_ids: ids,
      success: (res) => {
        const ok = ids.some((id) => res[id] === 'accept');
        if (ok) {
          api.post('/mp/subscribe', { template_id: ids[0] }, { auth: true, silent: true })
            .then(() => resolve({ granted: true }))
            .catch(() => resolve({ granted: false, reason: 'server' }));
        } else {
          resolve({ granted: false, reason: 'rejected' });
        }
      },
      fail: () => resolve({ granted: false, reason: 'fail' }),
    });
  }));
}

module.exports = { requestSubscribe, templates };
