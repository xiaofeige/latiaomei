// 我的：微信身份卡、权限说明、运维动作、图片库、导出。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');
const wxauth = require('../../utils/wxauth');
const config = require('../../config');

const ROLE_TEXT = { owner: '主人', admin: '管理员', pending: '只读待审', banned: '已拉黑' };
const ENV_TEXT = { release: '正式版', trial: '体验版', develop: '开发版' };

// 小程序版本：正式版用微信运行时回传的版本号；体验/开发版运行时给空串，
// 兜底用包内构建常量 config.APP_VERSION（CI 上传时自动同步为 --v 值）。
function readAppVersion() {
  let mp = {};
  try { mp = (wx.getAccountInfoSync() || {}).miniProgram || {}; } catch (e) { /* 老基础库兼容 */ }
  let sdk = '';
  try {
    sdk = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()).SDKVersion || '';
  } catch (e) { /* ignore */ }
  const env = ENV_TEXT[mp.envVersion] || '';
  const fromRuntime = !!mp.version;
  const ver = mp.version || config.APP_VERSION || '';
  return {
    verText: (ver ? 'v' + ver : '未知版本') + (env ? ' · ' + env : ''),
    envText: env || '未知环境',
    sdkText: sdk || '-',
    fullText: `辣条妹后台 ${ver ? 'v' + ver : '未知版本'}${env ? '（' + env + '）' : ''} 基础库 ${sdk || '-'}`
      + (fromRuntime || !ver ? '' : '（版本号来自包内构建常量）'),
  };
}

Page({
  // 分享：把后台拉更多管理员。新用户默认只读，在「成员管理」里放行。
  onShareAppMessage() { return require('../../utils/share').msg('/pages/mine/mine'); },
  onShareTimeline() { return require('../../utils/share').timeline(); },

  data: {
    nickname: '', avatar: '', initial: '我', role: '', roleText: '',
    canWrite: false, isOwner: false, idSub: '', loginCount: 0, firstSeen: '',
    healthText: '-', healthOk: false,
    dbText: '-', uploadText: '-', lastPrune: '-',
    verText: '-', envText: '-', sdkText: '-', fullText: '',
    uploads: [], uploadCount: 0, uploadVisible: false,
  },

  onShow() { this.load(); },

  load() {
    const role = session.getRole();
    const nick = session.getNickname();
    this.setData(readAppVersion());
    this.setData({
      role,
      roleText: ROLE_TEXT[role] || role || '未知',
      nickname: nick,
      avatar: session.getAvatar(),
      initial: (nick || '我').slice(0, 1),
      canWrite: role === 'owner' || role === 'admin',
      isOwner: role === 'owner',
      idSub: 'openid ' + (session.getOpenID() || '-'),
    });

    api.me().then((d) => {
      this.setData({
        role: d.role, roleText: ROLE_TEXT[d.role] || d.role,
        canWrite: !!d.can_write, isOwner: d.role === 'owner',
        nickname: d.nickname || this.data.nickname,
        avatar: d.avatar || this.data.avatar,
        loginCount: d.login_count || 0,
        firstSeen: d.first_seen_at ? fmt.date(d.first_seen_at) : '',
      });
    }).catch(() => {});

    api.health().then((h) => {
      this.setData({ healthOk: !!h.ok, healthText: h.ok ? `正常 · ${h.db_latency || ''}` : `异常 · ${h.error || ''}` });
    }).catch(() => this.setData({ healthText: '无法连接', healthOk: false }));

    api.overview(1).then((d) => {
      const st = d.storage || {};
      const rt = d.runtime || {};
      this.setData({
        dbText: fmt.bytes(st.db_bytes),
        uploadText: `${st.upload_files || 0} 张 / ${fmt.bytes(st.upload_bytes)}`,
        lastPrune: rt.last_prune_at ? fmt.date(Number(rt.last_prune_at)) : '从未',
      });
    }).catch(() => {});
  },

  nav(e) {
    const url = e.currentTarget.dataset.url;
    // AI 工坊已升为底部 Tab：Tab 页只能 switchTab 进。
    if (url === '/pages/pipeline/pipeline') { wx.switchTab({ url }); return; }
    wx.navigateTo({ url });
  },
  noop() {},

  // 点版本行复制完整版本串：报障/对版本时发给人方便。
  copyVer() {
    wx.setClipboardData({ data: this.data.fullText });
  },

  // 微信不再自动给昵称，需要用户点一下授权，所以做成手动入口。
  refreshProfile() {
    wxauth.fetchProfile().then((u) => {
      if (!u) { wx.showToast({ title: '没有拿到昵称，可稍后再试', icon: 'none' }); return; }
      // 昵称只是展示用，重新登录一次把它同步到服务端名单里。
      wxauth.relogin().then(() => { this.load(); wx.showToast({ title: '已更新', icon: 'success' }); }).catch(() => this.load());
    });
  },

  maint(e) {
    const action = e.currentTarget.dataset.a;
    const label = { flush: '落盘增量', prune: '清理过期统计', purge: '清孤儿图片', vacuum: '压缩数据库' }[action];
    wx.showModal({
      title: label, content: `确定执行「${label}」？`,
      success: (r) => {
        if (!r.confirm) return;
        api.maintenance(action).then((res) => {
          const detail = res && res.detail;
          const text = typeof detail === 'string' ? detail
            : (res && res.deleted !== undefined ? `删除 ${res.deleted} 个，释放 ${fmt.bytes(res.freed_bytes)}` : '已完成');
          wx.showToast({ title: text, icon: 'none', duration: 2500 });
          this.load();
        }).catch(() => {});
      },
    });
  },

  exportData() {
    wx.showLoading({ title: '导出中', mask: true });
    wx.downloadFile({
      url: config.API_BASE + config.API_PREFIX + '/admin/export',
      header: { Authorization: 'Bearer ' + session.getToken() },
      success: (res) => {
        wx.hideLoading();
        if (res.statusCode !== 200) { wx.showToast({ title: `导出失败(${res.statusCode})`, icon: 'none' }); return; }
        wx.openDocument({
          filePath: res.tempFilePath, fileType: 'json', showMenu: true,
          fail: () => wx.showModal({ title: '已下载', content: '打不开预览，可用右上角菜单转发到电脑保存。', showCancel: false }),
        });
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '导出失败，检查域名白名单', icon: 'none' }); },
      complete: () => wx.hideLoading(),
    });
  },

  showUploads() {
    this.setData({ uploadVisible: true });
    api.listUploads(100).then((d) => {
      const items = (d.items || []).map((u) => ({
        ...u, _url: fmt.fullUrl(u.thumb || u.path), _size: fmt.bytes(u.bytes), _date: fmt.date(u.created_at),
      }));
      const st = d.storage || {};
      this.setData({ uploads: items, uploadCount: items.length, uploadText: `${items.length} 张 / ${fmt.bytes(st.upload_bytes)}` });
    }).catch(() => {});
  },
  hideUploads() { this.setData({ uploadVisible: false }); },
  useUpload(e) { wx.setClipboardData({ data: e.currentTarget.dataset.path }); },

  delUpload(e) {
    const { id, path, used } = e.currentTarget.dataset;
    if (Number(used) > 0) { wx.showToast({ title: `这张图还被 ${used} 条内容用着`, icon: 'none' }); return; }
    wx.showModal({
      title: '删除图片', content: `确定删除 ${path}？`, confirmColor: '#a0503c',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteUpload(id).then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this.showUploads(); }).catch(() => {});
      },
    });
  },

  // 没有"退出"可言：微信身份一直在。这里只清本机 token 并立刻换一个新鲜的。
  clearLocal() {
    wx.showModal({
      title: '清除本机登录态',
      content: '会换一个全新的会话 token（权限不变）。通常只在怀疑会话出问题时用。',
      success: (r) => {
        if (!r.confirm) return;
        api.logout().catch(() => {}).then(() => {
          session.clear();
          return wxauth.relogin();
        }).then(() => {
          wx.showToast({ title: '已重新登录', icon: 'success' });
          this.load();
        }).catch(() => wx.showToast({ title: '重新登录失败，请重开小程序', icon: 'none' }));
      },
    });
  },
});
