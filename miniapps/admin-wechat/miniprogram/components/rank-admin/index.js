// 榜单管理组件：底部 Tab「私厨」「探店」共用。
// 每行左侧有常规拖拽手柄 ⠿：按住手柄上下拖即可调整名次（catch 系列事件挂在
// 手柄上，拖动手势不会和列表滚动打架；拖到列表上下边缘时通过 scroll-top 绑定
// 驱动列表慢滚，长榜也能从头拖到尾）。松手后点「保存名次」批量写 rank_no=1..N。
// 行内另有 发布/下线、删除；右下 ＋ 录入；右上 草稿 开关、档案 入口（探店）。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');

const CFG = {
  tandian: { name: '探店', emoji: '🌶', showArchive: true },
  yushanfang: { name: '私厨', emoji: '🍳', showArchive: false },
};

const EDGE = 60;      // 距列表上下边缘多少 px 内开始慢滚
const EDGE_STEP = 12; // 每个 tick / 每次 move 滚动的像素

Component({
  properties: {
    kind: { type: String, value: 'tandian' },
  },

  data: {
    cfg: CFG.tandian,
    mode: 'rank', // rank=榜单（可拖）| draft=草稿箱 | search=搜索结果
    items: [],
    total: 0,
    loading: false,
    dirty: false,
    canWrite: false,
    q: '',
    scrollSet: 0, // 传给 scroll-view 的 scroll-top，拖拽到边缘时由组件驱动
  },

  lifetimes: {
    attached() {
      const kind = this.data.kind in CFG ? this.data.kind : 'tandian';
      this.setData({ cfg: CFG[kind], canWrite: session.canWrite() });
      this._skipShow = true; // attached 后紧跟的 show 不重复拉
      this.reload();
    },
    detached() { this._stopEdge(); },
  },

  pageLifetimes: {
    show() {
      if (this._skipShow) { this._skipShow = false; return; }
      this.setData({ canWrite: session.canWrite() });
      // 从"店铺档案 · 看它的点评"带过来的搜索词（Tab 页不能传参，用 globalData 递话）。
      const app = getApp();
      const pre = app && app.globalData && app.globalData.rankQuery;
      if (pre && pre.kind === this.properties.kind) {
        app.globalData.rankQuery = null;
        this.setData({ q: pre.q || '', mode: pre.q ? 'search' : 'rank' });
      }
      this.reload();
    },
  },

  // 注意：自定义方法必须包在 methods 里，Component 顶层只认 properties/data/lifetimes/pageLifetimes 等保留字段，
  // 直接挂在顶层会全部静默失效（曾经因此两个榜单 tab 全空）。
  methods: {
  reload() { return this.load(); },

  load() {
    const kind = this.properties.kind;
    const mode = this.data.mode;
    this.setData({ loading: true });
    let p;
    if (mode === 'rank') {
      p = api.listReviews({ status: 'published', kind, sort: 'rank', page: 1, size: 200 });
    } else if (mode === 'draft') {
      p = api.listReviews({ status: 'draft', kind, sort: 'new', page: 1, size: 200 });
    } else {
      p = api.listReviews({ status: 'all', kind, q: this.data.q, sort: 'new', page: 1, size: 100 });
    }
    return p.then((d) => {
      const items = (d.items || []).map((it) => {
        const t = fmt.tier(it.tier);
        return {
          id: it.id,
          dish: it.dish,
          score: it.score,
          status: it.status,
          tier_label: t.label,
          tier_color: t.color,
          shop: it.shop ? it.shop.name : '',
          rank_no: it.rank_no,
          wheel: !!it.wheel,
          _tf: 0,
          _drag: false,
        };
      });
      this.setData({ items, total: d.total || 0, loading: false }, () => this._measure());
    }).catch(() => this.setData({ loading: false }));
  },

  // ---- 顶栏 ----
  toggleDraft() {
    const next = this.data.mode === 'draft' ? 'rank' : 'draft';
    const go = () => this.setData({ mode: next, dirty: false }, () => this.reload());
    if (this.data.dirty) {
      wx.showModal({ title: '有未保存的名次改动', content: '切换会丢掉刚才的拖拽结果', confirmText: '切换', success: (r) => { if (r.confirm) go(); } });
    } else { go(); }
  },

  onQInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() {
    if (!this.data.q) { this.setData({ mode: 'rank' }); this.reload(); return; }
    this.setData({ mode: 'search', dirty: false }, () => this.reload());
  },
  onClear() { this.setData({ q: '', mode: 'rank' }, () => this.reload()); },

  // ---- 名次微调 + 改分：点名次牌弹动作面板（拖拽之外的精确通道）----
  rowOps(e) {
    if (!this.data.canWrite || this.data.mode !== 'rank') return;
    const i = Number(e.currentTarget.dataset.i);
    const it = this.data.items[i];
    if (!it) return;
    const ops = [];
    if (i > 0) ops.push('上移一位');
    if (i < this.data.items.length - 1) ops.push('下移一位');
    if (i > 0) ops.push('置首');
    ops.push('改评分', '去详情页编辑');
    wx.showActionSheet({
      itemList: ops,
      success: (r) => {
        const op = ops[r.tapIndex];
        if (op === '上移一位') this._move(i, i - 1);
        else if (op === '下移一位') this._move(i, i + 1);
        else if (op === '置首') this._move(i, 0);
        else if (op === '改评分') this._scoreModal(it, i);
        else this.edit({ currentTarget: { dataset: { id: it.id } } });
      },
    });
  },
  // 本地换位：和拖拽同一套 dirty→保存名次 通道，不直接写库。
  _move(from, to) {
    const items = this.data.items.slice();
    const [row] = items.splice(from, 1);
    items.splice(to, 0, row);
    this.setData({ items, dirty: true });
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
  },

  quickScore(e) {
    const { i, id, score, dish } = e.currentTarget.dataset;
    this._scoreModal({ id, score, dish }, Number(i));
  },
  // 改分：先回读全量点评（保存是整行更新，缺字段会把 slug 等洗掉），只换 score 后写回。
  _scoreModal(it, index) {
    if (!this.data.canWrite) { wx.showToast({ title: '只读身份不能改分', icon: 'none' }); return; }
    wx.showModal({
      title: `改评分：${it.dish || ''}`.slice(0, 20),
      editable: true, placeholderText: `当前 ${it.score} 分；输 0-5，可带一位小数（如 4.5）`,
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(String(r.content || '').trim());
        if (!(v >= 0 && v <= 5)) { wx.showToast({ title: '评分得在 0 到 5 之间', icon: 'none' }); return; }
        api.getReview(it.id).then((rv) => {
          const body = {
            id: rv.id, slug: rv.slug, kind: rv.kind, shop_id: rv.shop_id || 0, dish: rv.dish,
            tier: rv.tier, score: v, spicy: rv.spicy || 0, price: rv.price || 0,
            headline: rv.headline || '', body: rv.body || '', order_tip: rv.order_tip || '',
            revisit: rv.revisit || 0, visit_date: rv.visit_date || '', cover: rv.cover || '',
            images: rv.images || [], featured: !!rv.featured, wheel: rv.wheel !== false,
            rank_no: rv.rank_no || 0, status: rv.status || 'draft',
            tastes: (rv.tastes || []).map((t) => t.slug),
          };
          return api.updateReview(rv.id, body);
        }).then(() => {
          wx.showToast({ title: `已改为 ${v} 分`, icon: 'success' });
          // 列表行就地更新，免全量重拉。
          this.setData({ [`items[${index}].score`]: v });
        }).catch(() => {});
      },
    });
  },

  goArchive() { wx.navigateTo({ url: '/pages/shop-archive/shop-archive' }); },
  noop() {}, // 手柄上的轻点：只拦截、不触发行的编辑跳转。
  create() { wx.navigateTo({ url: '/pages/review-edit/review-edit?kind=' + this.properties.kind }); },
  edit(e) { wx.navigateTo({ url: '/pages/review-edit/review-edit?id=' + e.currentTarget.dataset.id }); },

  publish(e) { this._setStatus(e.currentTarget.dataset.id, 'published'); },
  unpublish(e) { this._setStatus(e.currentTarget.dataset.id, 'draft'); },
  _setStatus(id, status) {
    api.setReviewStatus(id, status).then(() => {
      wx.showToast({ title: status === 'published' ? '已发布' : '已下线为草稿', icon: 'success' });
      this.reload();
    }).catch(() => {});
  },

  remove(e) {
    const { id, dish } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认删除',
      content: `删除「${dish}」？此操作不可撤销。`,
      confirmColor: '#a0503c',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteReview(id).then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this.reload(); }).catch(() => {});
      },
    });
  },

  // ---- 量尺寸：行步长（拖拽按它算名次）+ 列表可视区（边缘慢滚用）----
  _measure() {
    this.createSelectorQuery().selectAll('.ra-row').boundingClientRect((rects) => {
      if (rects && rects.length >= 2) this._pitch = rects[1].top - rects[0].top;
      else if (rects && rects.length === 1) this._pitch = rects[0].height;
    }).exec();
    this.createSelectorQuery().select('.ra-scroll').boundingClientRect((rect) => {
      if (rect) this._rect = rect;
    }).exec();
  },

  onScroll(e) {
    // 记录真实滚动位置。拖拽中通过 scroll-top 驱动的滚动也会触发这里，
    // 所以 _liveScroll 始终是当前视图的真实偏移。
    this._liveScroll = e.detail.scrollTop;
  },

  // ---- 手柄拖拽 ----
  onGripStart(e) {
    if (!this.data.canWrite || this.data.mode !== 'rank') return;
    const n = this.data.items.length;
    if (n < 2 || !this._pitch) return;
    const i = Number(e.currentTarget.dataset.i);
    this._from = i;
    this._target = i;
    this._startY = e.touches[0].clientY;
    this._lastY = this._startY;
    this._startScroll = this._liveScroll || 0;
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
    const patch = {};
    this.data.items.forEach((it, idx) => {
      patch[`items[${idx}]._drag`] = idx === i;
      patch[`items[${idx}]._tf`] = 0;
    });
    this.setData(patch);
    this._startEdge();
  },

  onGripMove(e) {
    if (this._from === undefined) return;
    const y = e.touches[0].clientY;
    this._lastY = y;
    this._edgeAdjust(y);
    this._apply(y);
  },

  onGripEnd() {
    if (this._from === undefined) return;
    this._stopEdge();
    const i = this._from, t = this._target;
    const items = this.data.items.slice();
    const [row] = items.splice(i, 1);
    items.splice(t, 0, row);
    items.forEach((it) => { it._tf = 0; it._drag = false; });
    this._from = undefined;
    this._target = undefined;
    this.setData({ items, dirty: t !== i });
    this._measure();
  },

  // 手指位移（含列表慢滚补偿）→ 被拖行的视觉偏移 + 被跨过行让位一格。
  _apply(clientY) {
    const i = this._from;
    const n = this.data.items.length;
    const pitch = this._pitch || 60;
    const off = (clientY - this._startY) + ((this._liveScroll || 0) - this._startScroll);
    let t = Math.round(i + off / pitch);
    t = Math.max(0, Math.min(n - 1, t));
    const patch = { [`items[${i}]._tf`]: off };
    if (t !== this._target) {
      this.data.items.forEach((it, idx) => {
        if (idx === i) return;
        let tf = 0;
        if (i < t && idx > i && idx <= t) tf = -pitch;
        else if (i > t && idx >= t && idx < i) tf = pitch;
        patch[`items[${idx}]._tf`] = tf;
      });
      this._target = t;
    }
    this.setData(patch);
  },

  // 边缘慢滚：手指停在可视区上/下 EDGE px 内时，持续把列表往那个方向挪。
  _edgeAdjust(clientY) {
    const rect = this._rect;
    if (!rect) return;
    const cur = this._liveScroll || 0;
    let ns = cur;
    if (clientY < rect.top + EDGE) ns = Math.max(0, cur - EDGE_STEP);
    else if (clientY > rect.bottom - EDGE) ns = cur + EDGE_STEP;
    if (ns !== cur) {
      this._liveScroll = ns;
      this.setData({ scrollSet: ns });
    }
  },

  _startEdge() {
    this._stopEdge();
    // 手指按住不动也要滚，所以除 move 事件外再挂一个定时器。
    this._edgeTimer = setInterval(() => {
      if (this._from === undefined) return;
      this._edgeAdjust(this._lastY);
      this._apply(this._lastY);
    }, 60);
  },
  _stopEdge() {
    if (this._edgeTimer) { clearInterval(this._edgeTimer); this._edgeTimer = null; }
  },

  // ---- 名次保存 ----
  save() {
    if (!this.data.dirty) return;
    const ids = this.data.items.map((it) => it.id);
    api.saveRanks({ kind: this.properties.kind, ids }).then(() => {
      wx.showToast({ title: '名次已保存', icon: 'success' });
      this.setData({ dirty: false });
      this.reload();
    }).catch(() => {});
  },

  discard() {
    wx.showModal({
      title: '放弃改动', content: '恢复成服务器上的当前顺序？',
      success: (r) => { if (r.confirm) this.reload(); },
    });
  },
  },
});
