// 站点设置：按分组渲染已知 key，只把改动过的字段提交回后端。
const api = require('../../utils/api');
const guard = require('../../utils/guard');

const SECTIONS = [
  {
    title: '站点',
    fields: [
      { key: 'site_title', label: '站点标题' },
      { key: 'site_tagline', label: '一句话标语' },
      { key: 'announcement', label: '公告条（留空则不显示）' },
      { key: 'footer_note', label: '页脚文案' },
      { key: 'icp', label: 'ICP 备案号（留空则不显示）' },
    ],
  },
  {
    title: '辣条妹人设（10年老杭州外地人 · 只做杭州美食）',
    fields: [
      { key: 'ip_name', label: 'IP 名称' },
      { key: 'ip_handle', label: '社交账号' },
      { key: 'ip_city', label: '所在城市' },
      { key: 'fans_display', label: '粉丝数（展示用）' },
      { key: 'ip_avatar', label: '头像地址', ph: '/img/…' },
      { key: 'ip_quote', label: '一句话签名' },
      { key: 'ip_bio', label: '个人简介', type: 'textarea' },
    ],
  },
  {
    title: '社媒链接',
    fields: [
      { key: 'douyin_url', label: '抖音' },
      { key: 'xhs_url', label: '小红书' },
    ],
  },
  {
    title: 'AI 流水线（自动产文案；发布必须人工在「AI 流水线」页放行）',
    fields: [
      { key: 'pipeline_enabled', label: '总开关：内容发布后自动产四平台待审文案', type: 'switch' },
      { key: 'pipeline_xiaohongshu', label: '小红书文案（图文·主战场）', type: 'switch' },
      { key: 'pipeline_zhihu', label: '知乎文案（长文）', type: 'switch' },
      { key: 'pipeline_weibo', label: '微博文案（短图文）', type: 'switch' },
      { key: 'pipeline_douyin', label: '抖音文案（视频，需成片+cookie）', type: 'switch' },
      { key: 'pipeline_video', label: '抖音视频渲染（hyperframes）', type: 'switch' },
      { key: 'pipeline_gzh', label: '公众号同步发文', type: 'switch' },
      { key: 'pipeline_wxpush', label: '小程序订阅消息推送', type: 'switch' },
      { key: 'video_daily_cap', label: '每日视频产能上限' },
    ],
  },
  {
    title: 'SEO 与运行',
    fields: [
      { key: 'seo_description', label: '站点描述', type: 'textarea' },
      { key: 'page_size', label: '列表每页条数' },
      { key: 'track_enabled', label: '开启访问统计', type: 'switch' },
      { key: 'allow_bots', label: '允许爬虫计入统计', type: 'switch' },
    ],
  },
];

Page({
  data: { sections: [], saving: false },

  onLoad() {
    if (!guard.requireWrite('/pages/dashboard/dashboard')) return;
    this.load();
  },

  load() {
    api.getSettings().then((d) => {
      const all = d.settings || {};
      // 深拷贝一份模板，把当前值灌进去，避免直接改常量。
      const sections = SECTIONS.map((sec) => ({
        title: sec.title,
        fields: sec.fields.map((f) => ({ ...f, value: all[f.key] === undefined ? '' : all[f.key] })),
      }));
      this._original = JSON.parse(JSON.stringify(all));
      this.setData({ sections });
    }).catch(() => {});
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    this._patch(k, e.detail.value);
  },
  onSwitch(e) {
    const k = e.currentTarget.dataset.k;
    this._patch(k, e.detail.value ? '1' : '0');
  },

  // 改动同步进 data，保持界面与数据一致。
  _patch(key, value) {
    const sections = this.data.sections.map((sec) => ({
      ...sec,
      fields: sec.fields.map((f) => (f.key === key ? { ...f, value } : f)),
    }));
    this.setData({ sections });
  },

  save() {
    const changed = {};
    const orig = this._original || {};
    this.data.sections.forEach((sec) => sec.fields.forEach((f) => {
      if (String(orig[f.key] === undefined ? '' : orig[f.key]) !== String(f.value)) {
        changed[f.key] = String(f.value);
      }
    }));

    if (!Object.keys(changed).length) { wx.showToast({ title: '没有需要保存的改动', icon: 'none' }); return; }

    this.setData({ saving: true });
    api.saveSettings(changed)
      .then(() => { wx.showToast({ title: `已保存 ${Object.keys(changed).length} 项`, icon: 'success' }); this.load(); })
      .catch(() => {})
      .then(() => this.setData({ saving: false }));
  },
});
