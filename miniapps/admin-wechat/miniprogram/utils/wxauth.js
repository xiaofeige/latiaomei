// 微信静默登录：wx.login 拿 code → 后端换 openid + 会话 token。
// 端上不出现任何账号密码页，用户扫二维码就直接进控制台。
const config = require('../config');
const session = require('./session');

// 同一时刻只允许一次登录在途：冷启动时多个页面会同时发请求，
// 不合并的话会各自 wx.login 一次、互相覆盖 token，出现"刚登录就 401"。
let pending = null;

// 把各种失败归成可辨识的类别，配合 app.js 给出准确提示。
// 踩过的坑：早期版本不分原因一律提示"被移出管理员名单"，
// 而真实原因绝大多数是域名没加白名单，直接把人带偏。
function classify(err, statusCode, body) {
  const msg = (body && body.error) || '';
  const mk = (kind, text) => ({ kind, text, message: text }); // 带 message 兼容旧调用方
  if (statusCode === 403 && (msg.includes('名单') || msg.includes('拉黑'))) return mk('banned', msg);
  if (statusCode === 401) return mk('credential', msg || '微信登录凭证无效，请重开小程序');
  if (statusCode === 502) return mk('server', msg || '服务端连不上微信接口，检查 AppID/AppSecret 配置');
  if (statusCode && statusCode >= 500) return mk('server', msg || `服务端异常(${statusCode})`);
  if (statusCode) return mk('http', msg || `请求失败(${statusCode})`);

  const e = String((err && (err.errMsg || err.message)) || '');
  if (e.includes('url not in domain list')) {
    return mk('domain', '域名未加入白名单：请到微信公众平台 → 开发管理 → 开发设置 → 服务器域名，' +
      '把 https://latiaomei.infinityfly.xin 加进 request 合法域名（小程序会强制校验，开发工具里可临时勾选"不校验合法域名"）。');
  }
  if (e.includes('login:fail') || e.includes('getCode')) {
    return mk('wxlogin', 'wx.login 没拿到 code，请重开小程序或重启微信');
  }
  if (e) return mk('network', `网络请求失败：${e}`);
  return mk('unknown', '初始化失败');
}

function rawLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res || !res.code) {
          reject(classify({ errMsg: 'login:fail 没拿到 code' }));
          return;
        }
        wx.request({
          url: config.API_BASE + config.API_PREFIX + '/admin/wx/login',
          method: 'POST',
          // 昵称/头像来自 getUserProfile，用户可拒绝；拿不到就留空，不影响登录。
          data: { code: res.code, nickname: session.getNickname(), avatar: session.getAvatar() },
          header: { 'Content-Type': 'application/json' },
          timeout: config.REQUEST_TIMEOUT,
          success(r) {
            const body = r.data;
            if (r.statusCode === 200 && body && body.ok) {
              session.save(body.data);
              resolve(body.data);
              return;
            }
            reject(classify(null, r.statusCode, body));
          },
          fail(err) { reject(classify(err)); },
        });
      },
      fail(err) { reject(classify(err)); },
    });
  });
}

// 确保有可用会话；没有就登录。并发调用共享同一个在途 Promise。
function ensure() {
  if (session.isValid()) return Promise.resolve({ cached: true, role: session.getRole() });
  if (pending) return pending;
  pending = rawLogin().then((d) => { pending = null; return d; })
    .catch((e) => { pending = null; throw e; });
  return pending;
}

// 401 时强制重登一次（token 过期或被 owner 踢下线）。
function relogin() {
  session.clear();
  pending = null;
  return rawLogin();
}

// 拉一次昵称头像。需要用户点击触发，所以只在"我的"页里主动调用。
function fetchProfile() {
  return new Promise((resolve) => {
    if (!wx.getUserProfile) { resolve(null); return; } // 旧基础库没有这个 API
    wx.getUserProfile({
      desc: '用于在成员名单里显示你的名字',
      success: (res) => {
        const u = res.userInfo || {};
        wx.setStorageSync('lm_wx_nick', u.nickName || '');
        wx.setStorageSync('lm_wx_avatar', u.avatarUrl || '');
        resolve(u);
      },
      fail: () => resolve(null),
    });
  });
}

module.exports = { ensure, relogin, fetchProfile };
