// wx.request 封装。与"账号密码 + 跳登录页"的常规做法不同：
// 这里的身份是微信，所以 ① 请求前先确保已静默登录；② 401 就重登一次并重放原请求；
// ③ 只有重登也失败才提示用户，不再往登录页跳（小程序里没有登录页）。
const config = require('../config');
const session = require('./session');
const wxauth = require('./wxauth');

function send(opts) {
  const { path, method = 'GET', data = {}, header = {}, auth = true } = opts;
  const h = Object.assign({ 'Content-Type': 'application/json' }, header);
  if (auth) {
    const t = session.getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.API_BASE + config.API_PREFIX + path,
      method, data, header: h, timeout: config.REQUEST_TIMEOUT,
      success: resolve,
      fail: reject,
    });
  });
}

function bodyError(res) {
  const b = res && res.data;
  return (b && b.error) || `请求失败(${res && res.statusCode})`;
}

/**
 * @param {Object} opts
 * @param {string} opts.path
 * @param {string} [opts.method=GET]
 * @param {Object} [opts.data]
 * @param {boolean} [opts.auth=true]   是否需要身份（登录接口本身传 false）
 * @param {boolean} [opts.loading]     显示 loading
 * @param {boolean} [opts.silent]      失败不弹提示
 * @param {boolean} [opts._retried]    内部用：标记已重登重试过
 */
function request(opts) {
  const { loading = false, silent = false, _retried = false } = opts || {};
  if (loading) wx.showLoading({ title: '处理中', mask: true });

  const finish = (fn) => { if (loading) wx.hideLoading(); return fn(); };

  // 先保证有会话，再发请求。
  return (opts.auth === false ? Promise.resolve() : wxauth.ensure())
    .then(() => send(opts))
    .then((res) => {
      // 会话失效：静默重登一次，然后重放原请求，用户完全无感。
      if (res.statusCode === 401 && opts.auth !== false && !_retried) {
        return wxauth.relogin()
          .then(() => request(Object.assign({}, opts, { _retried: true, loading: false })))
          .then(finish)
          .catch((e) => finish(() => {
            const t = (e && e.text) || '登录态已失效，请重开小程序';
            if (!silent) wx.showToast({ title: t, icon: 'none', duration: 2500 });
            throw e;
          }));
      }
      if (res.statusCode === 401) {
        return finish(() => {
          if (!silent) wx.showToast({ title: '没有后台权限', icon: 'none' });
          throw new Error('unauthorized');
        });
      }
      // 403：只读身份动了写操作。后端已给出人话提示，原样透出。
      if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.ok) {
        return finish(() => res.data.data);
      }
      const msg = bodyError(res);
      if (!silent) wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      const err = new Error(msg);
      err.status = res.statusCode;
      throw err;
    })
    .catch((err) => {
      if (loading) wx.hideLoading();
      // 网络层失败（非 HTTP 错误）：把域名白名单这种常见原因直接说出来。
      const e = String((err && (err.errMsg || err.message)) || '');
      if (err && err.kind === 'domain') {
        if (!silent) wx.showModal({ title: '域名未加白名单', content: err.text, showCancel: false });
      } else if (e && !err.status && err.kind !== 'banned' && err.kind !== 'credential') {
        if (!silent) wx.showToast({ title: '网络异常，检查域名白名单或网络', icon: 'none' });
      }
      throw err;
    });
}

module.exports = {
  request,
  get: (path, data, opt) => request(Object.assign({ path, method: 'GET', data }, opt)),
  post: (path, data, opt) => request(Object.assign({ path, method: 'POST', data }, opt)),
  put: (path, data, opt) => request(Object.assign({ path, method: 'PUT', data }, opt)),
  del: (path, data, opt) => request(Object.assign({ path, method: 'DELETE', data }, opt)),
};
