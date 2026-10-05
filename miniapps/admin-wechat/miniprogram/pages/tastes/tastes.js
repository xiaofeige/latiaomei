// 口味/场景标签管理：一个页面里完成增、改名、删。
const api = require('../../utils/api');
const guard = require('../../utils/guard');

Page({
  data: { groups: [], newName: '', newKind: 'taste' },

  onShow() {
    if (!guard.requireWrite('/pages/dashboard/dashboard')) return;
    this.reload();
  },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },

  reload() {
    return api.listTastes('').then((list) => {
      const taste = (list || []).filter((t) => t.kind !== 'scene');
      const scene = (list || []).filter((t) => t.kind === 'scene');
      this.setData({
        groups: [
          { kind: 'taste', label: '口味标签', list: taste },
          { kind: 'scene', label: '场景标签', list: scene },
        ],
      });
    }).catch(() => {});
  },

  onNewName(e) { this.setData({ newName: e.detail.value }); },
  setKind(e) { this.setData({ newKind: e.currentTarget.dataset.v }); },

  add() {
    const name = this.data.newName.trim();
    if (!name) { wx.showToast({ title: '先填标签名', icon: 'none' }); return; }
    api.saveTaste({ id: 0, slug: '', name, kind: this.data.newKind, sort_no: 0 })
      .then(() => { this.setData({ newName: '' }); wx.showToast({ title: '已添加', icon: 'success' }); this.reload(); })
      .catch(() => {});
  },

  // 改名：只改名字，slug 保持不动，免得历史链接失效。
  rename(e) {
    const { id, name, kind } = e.currentTarget.dataset;
    wx.showModal({
      title: '修改标签名',
      editable: true,
      placeholderText: '新的标签名',
      content: name,
      success: (r) => {
        if (!r.confirm) return;
        const nn = (r.content || '').trim();
        if (!nn || nn === name) return;
        api.saveTaste({ id, name: nn, kind, slug: '', sort_no: 0 })
          .then(() => { wx.showToast({ title: '已更新', icon: 'success' }); this.reload(); })
          .catch(() => {});
      },
    });
  },

  remove(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除标签',
      content: `确定删除「${name}」？已发布点评上的这个标签会一并去掉。`,
      confirmColor: '#a0503c',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteTaste(id).then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this.reload(); }).catch(() => {});
      },
    });
  },
});
