// 小程序入口。没有登录页：启动即静默用微信身份换一个会话 token。
// 失败只有两种可能——网络问题，或这个微信被移出了管理员名单，都需要明确告知。
const wxauth = require('./utils/wxauth');
const session = require('./utils/session');
const api = require('./utils/api');
const config = require('./config');

App({
  globalData: { role: '', canWrite: false },

  onLaunch() {
    this.boot();
  },

  onShow() {
    // 切回前台只在会话真的快过期/丢了时才重登。每次 onShow 都 wx.login 既浪费，
    // 又轻易碰到微信 45011 频控。
    if (session.isValid()) {
      api.me().then((d) => this.syncRole(d)).catch(() => { /* 401 会走请求层自动重登 */ });
    } else {
      this.boot();
    }
  },

  boot() {
    wxauth.ensure()
      .then((d) => this.syncRole(d))
      .catch((err) => {
        const kind = (err && err.kind) || 'unknown';
        const detail = (err && err.text) || '初始化失败';
        const ADVICE = {
          domain: '这是小程序后台配置问题，不是权限问题。',
          network: '手机能上网吗？也可能是证书或服务端未就绪。',
          wxlogin: '重开小程序通常就好。',
          credential: '重开小程序通常就好。',
          server: '服务端拿 AppID/AppSecret 换 openid 失败，检查 deploy/latiaomei.env。',
          banned: '确实是被移出了名单。',
          http: '',
          unknown: '',
        };
        const title = kind === 'banned' ? '没有后台权限' : '连不上后台';
        wx.showModal({
          title,
          content: detail + (ADVICE[kind] ? '\n\n' + ADVICE[kind] : '') + `\n\n接口地址：${config.API_BASE}`,
          showCancel: true,
          cancelText: '关闭',
          confirmText: '复制诊断',
          success: (r) => {
            if (r.confirm) {
              wx.setClipboardData({ data: `kind=${kind}\n${detail}\napi=${config.API_BASE}` });
            }
          },
        });
      });
  },

  syncRole(d) {
    if (!d) return;
    this.globalData.role = d.role || session.getRole();
    this.globalData.canWrite = this.globalData.role === 'owner' || this.globalData.role === 'admin';
  },
});
