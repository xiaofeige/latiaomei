// wx.request 封装。内容接口匿名可用；只有订阅记账带用户小令牌（auth.js）。
const config = require('../config');

function send(path, method, data, withToken, timeout) {
  const h = { 'Content-Type': 'application/json' };
  if (withToken) {
    const t = wx.getStorageSync('mp_token');
    if (t) h.Authorization = 'Bearer ' + t;
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.API_BASE + config.API_PREFIX + path,
      method, data: data || {}, header: h,
      timeout: timeout || config.REQUEST_TIMEOUT,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.ok) {
          return resolve(res.data.data);
        }
        const msg = (res.data && res.data.error) || `请求失败(${res.statusCode})`;
        const e = new Error(msg);
        e.status = res.statusCode;
        reject(e);
      },
      fail: (e) => reject(new Error((e && e.errMsg) || '网络开小差了')),
    });
  });
}

/**
 * get/post(path, data, { silent, auth, timeout })：默认失败弹 toast；silent 只抛不弹。
 */
function mk(method) {
  return (path, data, opts = {}) => {
    const p = send(path, method, data, !!opts.auth, opts.timeout);
    if (!opts.silent) {
      return p.catch((e) => {
        wx.showToast({ title: e.message, icon: 'none', duration: 2500 });
        throw e;
      });
    }
    return p;
  };
}

module.exports = { get: mk('GET'), post: mk('POST') };
