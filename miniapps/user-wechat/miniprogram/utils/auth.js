// 静默登录：wx.login code → 后端换 openid + HMAC 小令牌（30 天）。
// 只为订阅记账有身份；看内容永远不需要登录态。
const api = require('./request');

let pending = null;

function login() {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    wx.login({
      success: (r) => {
        if (!r.code) return reject(new Error('wx.login 未返回 code'));
        api.post('/mp/wx/login', { code: r.code }, { silent: true })
          .then((d) => {
            wx.setStorageSync('mp_token', d.token);
            resolve(d.token);
          })
          .catch(reject);
      },
      fail: (e) => reject(new Error((e && e.errMsg) || '微信登录通道异常')),
    });
  }).finally(() => { pending = null; });
  return pending;
}

// 有令牌直接回；没有就登录。订阅动作前调用。
function ensureLogin() {
  const t = wx.getStorageSync('mp_token');
  return t ? Promise.resolve(t) : login();
}

module.exports = { login, ensureLogin };
