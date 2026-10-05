// 概览页（Tab1）：全站状态数据的唯一展示处。图表化呈现：
// 一次 /admin/overview(14) 拿齐今日/趋势/小时分布/来源/设备/热门/库存/运行状态，
// 另拉 AI 流水线全量水位（待审稿 + 队列排队/执行/失败 + worker 开关，细节在 pages/tasks），
// 管理员一屏看清"网站怎么样、机器在干嘛、欠我什么活"。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');

const HOUR_MAX = 72;   // 24h 柱最高像素（rpx）
const BAR_MAX = 170;   // 14 天趋势柱最高（rpx）
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function num(v) { return fmt.num(v || 0); }

Page({
  // 分享：把后台拉更多管理员。新用户默认只读，在「成员管理」里放行。
  onShareAppMessage() { return require('../../utils/share').msg('/pages/dashboard/dashboard'); },
  onShareTimeline() { return require('../../utils/share').timeline(); },

  data: {
    loading: true, loadError: '',
    today: {}, todayPvN: '0', todayUvN: '0',
    todayLabel: '', weekLabel: '', nowHour: '',
    deltaPv: 0, deltaPvAbs: 0, trendHint: '',
    hourlyBars: [],
    seriesBars: [], totalPv14: '0', avgPv14: '0', peak: { pv: 0 },
    picked: '', pickedDay: {},
    refBars: [], devBars: [], pathBars: [],
    content: {}, topReviews: [], topShops: [],
    ai: { pendingItems: 0, queued: 0, running: 0, published7: 0, failed: 0, workerOn: true },
    runtime: null, runtimeOpen: false,
    uptimeText: '', memText: '', dbText: '', uploadText: '',
    canWrite: false,
  },

  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.reload();
    this.loadAI();
  },
  onPullDownRefresh() {
    Promise.all([this.reload(), this.loadAI()]).then(() => wx.stopPullDownRefresh());
  },

  reload() {
    this.setData({ loading: !this.data.today.pv, loadError: '' });
    return api.overview(14)
      .then((d) => this.fill(d))
      .catch((e) => this.setData({ loadError: (e && e.message) || '网络异常，稍后再试' }));
  },

  fill(d) {
    const today = d.today || {};
    const yesterday = d.yesterday || {};
    const delta = (today.pv || 0) - (yesterday.pv || 0);
    let hint = '首日数据';
    if (yesterday.pv) {
      const pct = Math.round((delta / yesterday.pv) * 100);
      hint = delta >= 0 ? `较昨日 +${pct}%` : `较昨日 -${Math.abs(pct)}%`;
    }

    // 24 小时节奏：柱高归一化，当前小时高亮。
    const nowH = new Date().getHours();
    const hourly = d.hourly || [];
    const maxH = Math.max(1, ...hourly.map((h) => h.value || 0));
    const hourlyBars = hourly.map((h, i) => ({
      h: Math.max(3, Math.round(((h.value || 0) / maxH) * HOUR_MAX)),
      label: i % 6 === 0 ? h.name : '',
      name: h.name,
      now: String(h.name) === String(nowH) || String(h.name) === String(nowH).padStart(2, '0'),
    }));

    // 14 天趋势：PV/UV 双柱，UV 以 PV 峰值为参考系（同轴可比）。
    const series = d.series || [];
    this._rawSeries = series;
    const maxPv = Math.max(1, ...series.map((p) => p.pv || 0));
    const seriesBars = series.map((p) => ({
      date: p.date,
      cap: (p.date || '').slice(8),
      pvH: Math.max(4, Math.round(((p.pv || 0) / maxPv) * BAR_MAX)),
      uvH: Math.max(2, Math.round(((p.uv || 0) / maxPv) * BAR_MAX)),
    }));
    const totalPv = series.reduce((a, p) => a + (p.pv || 0), 0);
    const peak = { pv: maxPv === 1 && !totalPv ? 0 : maxPv };

    // 来源/设备：比例条宽度 = 占最大项的百分比（至少 6% 才看得见）。
    const toBars = (list, n) => {
      const top = (list || []).slice(0, n);
      const max = Math.max(1, ...top.map((x) => x.value || 0));
      return top.map((x) => ({ ...x, w: Math.max(6, Math.round(((x.value || 0) / max) * 100)) }));
    };

    const rt = d.runtime || null;
    const st = d.storage || {};
    const now = new Date();
    this.setData({
      loading: false,
      today,
      todayPvN: num(today.pv),
      todayUvN: num(today.uv),
      todayLabel: today.date || '',
      weekLabel: WEEK_CN[now.getDay()],
      nowHour: String(nowH).padStart(2, '0'),
      deltaPv: delta,
      deltaPvAbs: Math.abs(delta),
      trendHint: hint,
      hourlyBars,
      seriesBars,
      totalPv14: num(totalPv),
      avgPv14: num(Math.round(totalPv / Math.max(1, series.length))),
      peak,
      picked: '', pickedDay: {},
      refBars: toBars(d.top_refs, 4),
      devBars: toBars(d.devices, 4),
      pathBars: (d.top_paths || []).slice(0, 5),
      content: d.content || {},
      topReviews: (d.top_reviews || []).slice(0, 6),
      topShops: (d.top_shops || []).slice(0, 6),
      runtime: rt ? { ...rt, ok: true } : null,
      uptimeText: rt ? this.humanUptime(rt.uptime_secs) : '',
      memText: rt ? fmt.bytes(rt.mem_alloc) : '',
      dbText: st.db_bytes ? fmt.bytes(st.db_bytes) : '-',
      uploadText: st.upload_files ? `${st.upload_files} 个 / ${fmt.bytes(st.upload_bytes)}` : '空',
    });
  },

  // AI 水位（状态集中展示在 Tab1）：待审稿数 + 队列三态（排队/执行/失败）+ worker 开关 + 近 7 天已发布。
  loadAI() {
    const ai = { pendingItems: 0, queued: 0, running: 0, published7: 0, failed: 0, workerOn: true };
    return Promise.all([
      api.socialItems({ status: 'pending', limit: 1 }).catch(() => null),
      api.pipeTasks({ status: 'all', limit: 1 }).catch(() => null),
      api.socialItems({ status: 'published', limit: 200 }).catch(() => null),
    ]).then(([pend, queue, pub]) => {
      if (pend) ai.pendingItems = (pend.summary && pend.summary.pending) || 0;
      if (queue) {
        const sum = queue.summary || {};
        ai.queued = sum.pending || 0;
        ai.running = sum.running || 0;
        ai.failed = sum.failed || 0;
        ai.workerOn = queue.pipeline_on !== false;
      }
      if (pub) {
        const week = Date.now() / 1000 - 7 * 86400;
        ai.published7 = ((pub.items || []).filter((x) => (x.published_at || x.updated_at || 0) >= week)).length;
      }
      this.setData({ ai });
    });
  },

  pickDay(e) {
    const date = e.currentTarget.dataset.date;
    const inData = this._rawSeries && this._rawSeries.find((p) => p.date === date);
    this.setData({ picked: this.data.picked === date ? '' : date, pickedDay: inData || {} });
  },

  humanUptime(secs) {
    if (!secs) return '-';
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
    if (d > 0) return `${d} 天 ${h} 小时`;
    const m = Math.floor((secs % 3600) / 60);
    return `${h} 小时 ${m} 分`;
  },

  toggleRuntime() { this.setData({ runtimeOpen: !this.data.runtimeOpen }); },

  navTo(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  goAI() { wx.switchTab({ url: '/pages/pipeline/pipeline' }); },
  goTasks() { wx.navigateTo({ url: '/pages/tasks/tasks' }); },
  goContent() { wx.switchTab({ url: '/pages/content/content' }); },
  goAnalytics() { wx.navigateTo({ url: '/pages/analytics/analytics' }); },
  goDayDetail() {
    wx.navigateTo({ url: '/pages/analytics/analytics?date=' + this.data.picked });
  },
  goRank(e) {
    getApp().globalData = getApp().globalData || {};
    getApp().globalData.contentKind = e.currentTarget.dataset.kind;
    wx.switchTab({ url: '/pages/content/content' });
  },
  goDrafts() {
    wx.switchTab({ url: '/pages/content/content' });
  },
});
