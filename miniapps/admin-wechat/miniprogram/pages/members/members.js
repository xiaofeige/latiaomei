// 成员管理：owner 在这里放行/降级/拉黑。后端只认 openid。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');

const ROLE_TEXT = { owner: '主人', admin: '管理员', pending: '待审核', banned: '已拉黑' };

Page({
  data: { items: [], isOwner: false, openMode: false, loading: true },

  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  load() {
    this.setData({ loading: true });
    return api.members()
      .then((d) => {
        const me = session.getOpenID();
        const items = (d.items || []).map((m) => ({
          ...m,
          _roleText: ROLE_TEXT[m.role] || m.role,
          _initial: (m.nickname || m.openid || '?').slice(0, 1),
          _last: fmt.ago(m.last_seen_at),
          _first: fmt.date(m.first_seen_at),
          _isMe: m.openid === me,
        }));
        this.setData({
          items,
          isOwner: !!d.is_owner || session.getRole() === 'owner',
          openMode: !!d.open_mode,
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  act(e) {
    const { o, a } = e.currentTarget.dataset;
    const item = this.data.items.filter((m) => m.openid === o)[0];
    const who = (item && item.nickname) || (item ? item.openid_masked : o);
    const conf = {
      approve: ['放行', `让「${who}」成为管理员？他就能增删改站点内容了。`],
      demote: ['降为只读', `「${who}」将只能查看，不能修改。`],
      ban: ['拉黑', `拉黑「${who}」？他会立刻被踢下线，且无法再登录。`],
      unban: ['解除拉黑', `解除后「${who}」变为只读，需要再手动放行。`],
      remove: ['移除', `移除「${who}」的记录？他下次登录会重新作为新人进来。`],
    }[a];
    if (!conf) return;
    wx.showModal({
      title: conf[0], content: conf[1],
      confirmColor: a === 'ban' || a === 'remove' ? '#a0503c' : '#b58f4a',
      success: (r) => {
        if (!r.confirm) return;
        api.memberAction(o, a).then(() => {
          wx.showToast({ title: '已完成', icon: 'success' });
          this.load();
        }).catch(() => {});
      },
    });
  },

  setNote(e) {
    const { o, n } = e.currentTarget.dataset;
    wx.showModal({
      title: '备注', editable: true, placeholderText: '比如：小店员 / 外卖合伙人', content: n || '',
      success: (r) => {
        if (!r.confirm) return;
        api.memberAction(o, 'note', (r.content || '').trim()).then(() => {
          wx.showToast({ title: '已保存', icon: 'success' });
          this.load();
        }).catch(() => {});
      },
    });
  },
});
