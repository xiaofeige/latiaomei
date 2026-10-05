// 呼声墙：谁都能递愿望，谁的呼声（🌶）最高，辣条妹优先去踩。
// 墙是公开的：只出内容 + 固定马甲，联系方式与身份永不外泄。
// 提交可匿名；静默登录后带小令牌：「我递过的」可回看，点赞需要登录态（静默完成）。
const api = require('../../utils/request');
const auth = require('../../utils/auth');

const STICKER = { new: '待翻牌', read: '已阅', picked: '翻牌了', done: '替你踩了', rejected: '暂不做' };

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  const d = new Date(ts * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '-' + p(d.getDate());
}

function decorate(w) {
  return Object.assign({}, w, { sticker: STICKER[w.status] || w.status_text || '', timeTxt: ago(w.created_at) });
}

Page({
  data: {
    content: '', contact: '', len: 0, busy: false, canPost: true,
    mine: [], mineLoaded: false,
    wall: [], wsort: 'hot', wpage: 1, wTotal: 0, wHasMore: false,
    wLoading: true, wBusy: false,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setActive('wish');
    this.loadMine();
    this.loadWall(1);
  },

  onReachBottom() {
    if (this.data.wHasMore && !this.data.wBusy) this.loadWall(this.data.wpage + 1);
  },

  // 分享：把呼声墙转发给饭搭子，一起点菜
  onShareAppMessage() {
    return { title: '我给辣条妹点了道菜，就等她替我踩坑了 🙏', path: '/pages/wish/wish' };
  },
  onShareTimeline() {
    return { title: '呼声墙 · 想让辣条妹替你踩哪个坑' };
  },

  onInput(e) {
    const v = e.detail.value || '';
    this.setData({ content: v, len: v.length, canPost: v.trim().length >= 4 && v.length <= 200 });
  },

  onContact(e) { this.setData({ contact: e.detail.value || '' }); },

  /* ---------- 呼声墙 ---------- */

  loadWall(page) {
    this.setData({ wBusy: true });
    api.get('/mp/wish/wall', { sort: this.data.wsort, page: page, size: 20 }, { silent: true, auth: true })
      .then((d) => {
        const items = (d.wishes || []).map(decorate);
        this.setData({
          wall: page === 1 ? items : this.data.wall.concat(items),
          wpage: page, wTotal: d.total || 0, wHasMore: !!d.has_more,
          wLoading: false, wBusy: false,
        });
      })
      .catch(() => this.setData({ wLoading: false, wBusy: false }));
  },

  setSort(e) {
    const v = e.currentTarget.dataset.v;
    if (v === this.data.wsort || this.data.wBusy) return;
    this.setData({ wsort: v, wLoading: true, wall: [] });
    this.loadWall(1);
  },

  // 喊一声（🌶）：乐观更新，失败回滚；没登录先静默登录
  like(e) {
    const i = e.currentTarget.dataset.i;
    const item = this.data.wall[i];
    if (!item || this._liking) return;
    this._liking = true;
    const liked = !item.liked;
    const patch = {};
    patch['wall[' + i + '].liked'] = liked;
    patch['wall[' + i + '].likes'] = Math.max(0, item.likes + (liked ? 1 : -1));
    this.setData(patch);
    auth.ensureLogin()
      .then(() => api.post('/mp/wish/like', { id: item.id }, { silent: true, auth: true }))
      .then((d) => {
        const back = {};
        back['wall[' + i + '].liked'] = !!d.liked;
        back['wall[' + i + '].likes'] = d.likes || 0;
        this.setData(back);
        this._liking = false;
      })
      .catch((err) => {
        const back = {};
        back['wall[' + i + '].liked'] = !liked;
        back['wall[' + i + '].likes'] = item.likes;
        this.setData(back);
        this._liking = false;
        wx.showToast({ title: (err && err.message) || '喊不动，稍后再试', icon: 'none' });
      });
  },

  /* ---------- 我的条子 ---------- */

  loadMine() {
    const tok = wx.getStorageSync('mp_token');
    if (!tok) { this.setData({ mineLoaded: true }); return; }
    api.get('/mp/wish/mine', {}, { silent: true, auth: true }).then((d) => {
      const mine = (d.wishes || []).map(decorate);
      this.setData({ mine, mineLoaded: true });
    }).catch(() => this.setData({ mineLoaded: true }));
  },

  submit() {
    const content = this.data.content.trim();
    if (content.length < 4) {
      wx.showToast({ title: '再多写点，4 字起步', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true });
    // 有身份就记身份（方便回看批复 + 墙上标「我递的」）；静默登录失败不拦许愿
    auth.ensureLogin().catch(() => {}).then(() =>
      api.post('/mp/wish', { content: content, contact: this.data.contact.trim() }, { auth: true, silent: true })
    ).then(() => {
      this.setData({ content: '', len: 0, contact: '', busy: false, canPost: false });
      wx.showToast({ title: '愿已上墙，去喊人撑你', icon: 'none', duration: 2500 });
      this.loadMine();
      if (this.data.wsort !== 'new') {
        // 新愿望在「刚递的」榜首，切过去让人看到自己上了墙
        this.setData({ wsort: 'new', wLoading: true, wall: [] });
      }
      this.loadWall(1);
    }).catch((e) => {
      this.setData({ busy: false });
      wx.showToast({ title: (e && e.message) || '递条子没递出去，再试一次', icon: 'none' });
    });
  },
});
