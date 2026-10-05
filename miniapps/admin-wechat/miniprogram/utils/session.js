// 会话存储。微信身份即凭证，所以这里存的是 wx/login 换来的 token + 角色。
const KEY = 'lm_wx_token';
const KEY_ROLE = 'lm_wx_role';
const KEY_NICK = 'lm_wx_nick';
const KEY_AVATAR = 'lm_wx_avatar';
const KEY_OPENID = 'lm_wx_openid';
const KEY_EXP = 'lm_wx_exp';

module.exports = {
  getToken: () => wx.getStorageSync(KEY) || '',
  getRole: () => wx.getStorageSync(KEY_ROLE) || '',
  getNickname: () => wx.getStorageSync(KEY_NICK) || '',
  getAvatar: () => wx.getStorageSync(KEY_AVATAR) || '',
  getOpenID: () => wx.getStorageSync(KEY_OPENID) || '',
  getExpire: () => wx.getStorageSync(KEY_EXP) || 0,

  // 只有 owner / admin 能写；pending 是只读访客。
  canWrite() {
    const r = this.getRole();
    return r === 'owner' || r === 'admin';
  },

  save(d) {
    if (!d || !d.token) return;
    wx.setStorageSync(KEY, d.token);
    wx.setStorageSync(KEY_ROLE, d.role || 'pending');
    wx.setStorageSync(KEY_NICK, d.nickname || '');
    wx.setStorageSync(KEY_AVATAR, d.avatar || '');
    wx.setStorageSync(KEY_OPENID, d.openid || '');
    wx.setStorageSync(KEY_EXP, d.expires_at || 0);
  },

  clear() {
    [KEY, KEY_ROLE, KEY_NICK, KEY_AVATAR, KEY_OPENID, KEY_EXP].forEach((k) => wx.removeStorageSync(k));
  },

  // 本地粗判是否还有效（留 5 分钟余量）；权威判定以后端 401 为准。
  isValid() {
    if (!this.getToken()) return false;
    const exp = this.getExpire();
    if (!exp) return true;
    return exp - Math.floor(Date.now() / 1000) > 300;
  },
};
