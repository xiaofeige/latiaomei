// 任务队列（独立监控页，从概览 Tab 点入）：worker 排队/执行/失败明细 + 重试/放弃 + 手动补发。
// 定位是"盯机器"，不生产内容；创作都在「工作台」Tab 完成。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');
const guard = require('../../utils/guard');

const T_FILTERS = [
  { code: 'pending', label: '排队中' },
  { code: 'running', label: '执行中' },
  { code: 'failed', label: '失败' },
  { code: 'done', label: '完成' },
  { code: 'skipped', label: '跳过' },
  { code: 'all', label: '全部' },
];
const TS_LABEL = { pending: '排队中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' };

Page({
  data: {
    loading: true, canWrite: false, workerOn: true,
    tFilters: T_FILTERS, tFilter: 'pending',
    tasks: [], tSum: {},
    reviews: [], reviewNames: [], reviewIdx: -1,
    enqTypes: [
      { code: 'social_gen', label: '四平台文案（进待审）' },
      { code: 'video', label: '抖音视频渲染' },
      { code: 'gzh', label: '公众号发文' },
      { code: 'wxpush', label: '订阅推送' },
      { code: 'draft', label: 'AI 草稿' },
    ],
  },

  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.reload();
  },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },

  reload() {
    this.setData({ loading: true });
    return this.loadTasks().then(() => this.setData({ loading: false }))
      .catch(() => this.setData({ loading: false }));
  },

  loadTasks() {
    return api.pipeTasks({ status: this.data.tFilter, limit: 50 }).then((d) => {
      const tasks = (d.tasks || []).map((t) => ({
        ...t, _time: fmt.ago(t.created_at), _result: this.taskBrief(t),
        _status_label: TS_LABEL[t.status] || t.status, _video: this.taskVideo(t),
      }));
      this.setData({ tasks, tSum: d.summary || {}, workerOn: d.pipeline_on !== false });
      if (!this._reviewsLoaded) this.loadReviews();
    });
  },
  taskBrief(t) {
    if (t.error) return t.error.slice(0, 60);
    if (!t.result) return '';
    try {
      const r = JSON.parse(t.result);
      if (r.items) return `待审稿 #${r.items.join(' #')}`;
      if (r.published_to) return `去向：${r.published_to}`;
      if (r.pack) return r.pack;
      if (r.video) return r.video;
      return '';
    } catch { return String(t.result).slice(0, 60); }
  },
  taskVideo(t) {
    if (!t.result) return '';
    try {
      const r = JSON.parse(t.result);
      return r.video ? fmt.fullUrl(r.video) : '';
    } catch { return ''; }
  },
  switchTFilter(e) {
    this.setData({ tFilter: e.currentTarget.dataset.code }, () => this.loadTasks());
  },
  actTask(e) {
    const { id, a } = e.currentTarget.dataset;
    if (!guard.requireWrite('/pages/tasks/tasks')) return;
    api.taskAction(id, a).then(() => {
      wx.showToast({ title: a === 'retry' ? '已拨回队列' : '已放弃', icon: 'success' });
      this.loadTasks();
    }).catch(() => {});
  },

  // 补发用的内容清单（懒加载一次）
  loadReviews() {
    this._reviewsLoaded = true;
    return api.listReviews({ status: 'published', sort: 'new', size: 50 }).then((d) => {
      const reviews = d.items || [];
      this.setData({
        reviews,
        reviewNames: reviews.map((r) => `${r.dish} · ${r.shop ? r.shop.name : ''}（${fmt.date(r.published_at)}）`),
      });
    }).catch(() => { this._reviewsLoaded = false; });
  },
  onPickReview(e) { this.setData({ reviewIdx: Number(e.detail.value) }); },
  quickEnqueue(e) {
    const { code } = e.currentTarget.dataset;
    if (!guard.requireWrite('/pages/tasks/tasks')) return;
    const { reviewIdx, reviews } = this.data;
    const rid = reviewIdx >= 0 && reviews[reviewIdx] ? reviews[reviewIdx].id : 0;
    api.enqueueTask(code, rid).then((d) => {
      wx.showToast({ title: d.added ? '已入队' : '已有未终结的同类任务', icon: 'none' });
      this.loadTasks();
    }).catch(() => {});
  },
});
