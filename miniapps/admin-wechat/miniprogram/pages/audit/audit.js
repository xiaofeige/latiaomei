// 操作记录：把后端审计里的 action 翻译成人话。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');

const VERB = { POST: '新增', PUT: '修改', DELETE: '删除' };
const OBJ = {
  reviews: '点评', shops: '店铺', tastes: '标签', settings: '站点设置',
  upload: '图片', uploads: '图片库', maintenance: '运维', 'wx/member': '成员', 'wx.login': '登录',
};

function human(action) {
  const sp = action.indexOf(' ');
  const method = sp > 0 ? action.slice(0, sp) : action;
  const rest = sp > 0 ? action.slice(sp + 1) : '';
  if (rest.startsWith('wx/member')) {
    const k = rest.split('.')[1] || '';
    return '成员操作 · ' + ({ approve: '放行', demote: '降为只读', ban: '拉黑', unban: '解除拉黑', remove: '移除', note: '改备注' }[k] || k);
  }
  if (rest.startsWith('wx/login') || action === 'wx.login') return '微信登录';
  let obj = rest.split('/')[0] || rest;
  return (VERB[method] || method) + ' ' + (OBJ[obj] || obj);
}

Page({
  data: { items: [], shown: [], filter: 'all' },

  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  load() {
    return api.audit(200).then((d) => {
      const me = session.getOpenID();
      const items = (d.items || []).map((r) => ({
        ...r,
        _actionText: human(r.action),
        _at: fmt.date(r.at) + ' ' + new Date(r.at * 1000).toTimeString().slice(0, 5),
        _who: r.actor === me ? '我' : (r.actor ? r.actor.slice(0, 6) + '…' : '未知'),
        _isWx: r.action.indexOf('wx') === 0 || (r.actor || '').length > 20,
      }));
      this.setData({ items });
      this.applyFilter();
    }).catch(() => {});
  },

  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }, () => this.applyFilter()); },

  applyFilter() {
    const f = this.data.filter;
    const shown = this.data.items.filter((r) => {
      if (f === 'all') return true;
      if (f === 'wx') return r.action.indexOf('wx') === 0;
      return r.action.indexOf('wx') !== 0;
    });
    this.setData({ shown });
  },
});
