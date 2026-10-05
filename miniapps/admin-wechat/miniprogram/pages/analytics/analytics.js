// 访问分析：概览给 14 天趋势，点柱子下钻到某一天（走 /admin/analytics?date=）。
// 支持从概览页带 ?date= 进来直接看某天。
const api = require('../../utils/api');

const MAX_BAR = 160; // rpx

Page({
  data: {
    series: [],
    day: null,
    hourly: [],
    topPaths: [],
    topRefs: [],
    devices: [],
    selected: '',
    initDate: '',
  },

  onLoad(query) {
    this.setData({ initDate: (query && query.date) || '' });
    this.loadSeries();
  },
  onPullDownRefresh() { this.loadSeries().then(() => wx.stopPullDownRefresh()); },

  loadSeries() {
    return api.overview(14).then((d) => {
      const series = (d.series || []).map((p) => ({ ...p, _cap: (p.date || '').slice(8) }));
      const maxPv = Math.max(1, ...series.map((p) => p.pv || 0));
      series.forEach((p) => {
        p._pvH = Math.round(((p.pv || 0) / maxPv) * MAX_BAR);
        p._uvH = Math.round(((p.uv || 0) / maxPv) * MAX_BAR);
      });
      this.setData({ series });
      // 有入参看入参那天，否则默认今天。
      this.loadDay(this.data.initDate || (d.today && d.today.date));
      this.data.initDate = '';
    }).catch(() => {});
  },

  pickDay(e) { this.loadDay(e.currentTarget.dataset.date); },

  loadDay(date) {
    if (!date) return;
    api.analytics(date).then((d) => {
      const hourly = (d.hourly || []).map((h) => ({ ...h }));
      const maxH = Math.max(1, ...hourly.map((h) => h.value || 0));
      hourly.forEach((h) => { h._h = Math.round(((h.value || 0) / maxH) * 100); });
      this.setData({
        selected: date,
        day: d.day || null,
        hourly,
        topPaths: d.top_paths || [],
        topRefs: d.top_refs || [],
        devices: d.devices || [],
      });
    }).catch(() => {});
  },
});
