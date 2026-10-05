// 项目工作区（v13）：一条视频/一组文案 = 一个项目，多次交互而不是一键流水线。
// 流程：立项（标题+制片提示词+首批素材）→ 工作区里反复加图、改提示词 →
// 分步跑：出分镜（可手改 JSON）→ 用这版出成片（人物镜头走 happyhorse）→ 出平台文案 →
// 产物进「待放行」，放行才发布（铁律不变）。步骤留痕，跑坏重跑不丢历史。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');
const speech = require('../../utils/speech');
const guard = require('../../utils/guard');

const TS_LABEL = { pending: '排队中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' };
const ST_LABEL = { open: '进行中', review: '等放行', done: '已交付', archived: '已归档' };
let MAT_SEQ = 0;

// 本地兜底：服务端 LLM 没配时，至少把口语整理成分节结构（与旧工坊同款）。
function localStructure(text) {
  const t = String(text || '').trim();
  const first = (t.split(/[\n。！？!?]/)[0] || t).slice(0, 30);
  return [
    `【主题】${first}`,
    `【钩子】前 3 秒抛出主题里最馋人的那个点（由 AI 按内容自行发挥）`,
    `【素材使用】按上传顺序取用图片素材，第一张做首镜背景`,
    `【分镜要点】${t}`,
    `【主角】辣条妹 3D 形象出镜（三视图/特写自动挂载，人物镜头交给 happyhorse 生成）`,
    `【文案口吻】市井、直接、毒舌但公道，杭州话点缀；禁绝对化用语`,
    `【时长画幅】约 50 秒，1080x1920 竖屏`,
    `【行动号召】结尾引导关注、来主页看全文`,
    `【话题标签】#辣条妹的御膳房 #杭州美食`,
  ].join('\n');
}

Page({
  onShareAppMessage() { return require('../../utils/share').msg(`/pages/project/project?id=${this.data.pid}`); },

  data: {
    pid: 0, creating: true, canWrite: false, loading: true,
    project: null, stLabel: '',
    title: '', brief: '',
    assets: [], steps: [],
    voiceDraft: '', recording: false, speechOn: true, polishing: false, polishedBackup: '',
    stepPrompt: '', busyKind: '',
    renderer: 'hyperframes', // 出片引擎：hyperframes=图文卡+旁白 | openmontage=纯动态剪辑
    hhCount: 0,
    // 分镜弹层
    sbVisible: false, sbStepId: 0, sbText: '', sbReadonly: false,
    hhHint: '',
    pollTimer: null,
  },

  onLoad(q) {
    const pid = Number(q.id) || 0;
    this.setData({ pid, creating: !pid, speechOn: speech.available() });
    // 从「创作目标」带过来的方向：预填提示词，可继续改。
    const app = getApp();
    if (!pid && app && app.globalData && app.globalData.pendingProjectBrief) {
      this.setData({ brief: app.globalData.pendingProjectBrief });
      app.globalData.pendingProjectBrief = '';
    }
  },
  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.reload();
  },
  onHide() { this._stopPoll(); },
  onUnload() { this._stopPoll(); },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },

  reload() {
    if (this.data.creating) return Promise.resolve();
    this.setData({ loading: true });
    return api.project(this.data.pid).then((d) => {
      const p = d.project || {};
      const assets = (d.assets || []).map((a) => ({
        ...a, key: `a${a.id}`, _url: fmt.fullUrl(a.path), _time: fmt.ago(a.created_at),
      }));
      const steps = (d.steps || []).map((s) => this._decorateStep(s));
      this.setData({
        project: p, stLabel: ST_LABEL[p.status] || p.status,
        title: p.title, brief: p.brief, assets, steps, loading: false,
      });
      this._autoPoll(steps);
    }).catch(() => this.setData({ loading: false }));
  },
  _decorateStep(s) {
    let video = '', items = [], sceneCount = 0, note = '', engine = '';
    try {
      const r = JSON.parse(s.result || '{}');
      video = r.video ? fmt.fullUrl(r.video) : '';
      items = r.items || (r.item_id ? [r.item_id] : []);
      sceneCount = (r.scenes && r.scenes.length) || 0;
      note = s.note || r.note || '';
      engine = r.engine || '';
    } catch { /* 手改坏的分镜不拦展示 */ }
    return {
      ...s,
      _ts: TS_LABEL[s.status] || s.status,
      _time: fmt.ago(s.created_at),
      _video: video, _items: items, _scenes: sceneCount, _engine: engine,
      _canEditSb: s.kind === 'storyboard' && s.status === 'done' && !!s.result,
      _canVideo: s.kind === 'storyboard' && s.status === 'done',
    };
  },
  // 有步骤在排队/执行时 15s 自动刷一次，辣条妹不用手动下拉。
  _autoPoll(steps) {
    this._stopPoll();
    const busy = (steps || []).some((s) => s.status === 'pending' || s.status === 'running');
    if (!busy) return;
    const t = setTimeout(() => this.reload(), 15000);
    this.setData({ pollTimer: t });
  },
  _stopPoll() {
    if (this.data.pollTimer) { clearTimeout(this.data.pollTimer); this.setData({ pollTimer: null }); }
  },

  // ================= 立项 / 编辑 =================
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onBrief(e) { this.setData({ brief: e.detail.value }); },
  onStepPrompt(e) { this.setData({ stepPrompt: e.detail.value }); },

  saveMeta() {
    if (!guard.requireWrite(`/pages/project/project?id=${this.data.pid}`)) return;
    if (!this.data.title.trim()) { wx.showToast({ title: '标题不能空', icon: 'none' }); return; }
    api.saveProject(this.data.pid, { title: this.data.title.trim(), brief: this.data.brief }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' });
      this.reload();
    }).catch(() => {});
  },

  setProjectStatus(to) {
    api.saveProject(this.data.pid, { status: to }).then(() => {
      wx.showToast({ title: '已更新状态', icon: 'success' });
      this.reload();
    }).catch(() => {});
  },
  noop() {},

  submitCreate() {
    if (!guard.requireWrite('/pages/project/project')) return;
    const { title, brief, assets } = this.data;
    if (!title.trim()) { wx.showToast({ title: '给项目起个标题', icon: 'none' }); return; }
    const paths = assets.filter((x) => x.path).map((x) => x.path);
    if (!brief.trim() && !paths.length) { wx.showToast({ title: '提示词和素材至少给一样', icon: 'none' }); return; }
    api.createProject({ title: title.trim(), brief: brief.trim(), images: paths }).then((d) => {
      wx.showToast({ title: '立项成功', icon: 'success' });
      this.setData({ pid: d.id, creating: false, assets: [] });
      wx.setNavigationBarTitle({ title: d.title || '项目工作区' });
      this.reload();
    }).catch(() => {});
  },

  // ================= 素材（工作区加图 / 删图） =================
  pickImages() {
    if (!guard.requireWrite(`/pages/project/project?id=${this.data.pid}`)) return;
    wx.chooseMedia({
      count: 9, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        res.tempFiles.forEach((f) => {
          const key = `m${++MAT_SEQ}`;
          const cell = { id: 0, key, _url: f.tempFilePath, uploading: true, path: '', kind: 'image', note: '' };
          this.setData({ assets: this.data.assets.concat([cell]) });
          api.upload(f.tempFilePath).then((d) => {
            if (this.data.creating) {
              // 新建模式：图先留在格子里（带路径），随「立项」一起提交。
              this._patchAsset(key, { uploading: false, path: d.path });
            } else {
              api.addProjectAsset(this.data.pid, { path: d.path, kind: 'image' }).then((a) => {
                this._patchAsset(key, { id: a.id, path: a.path, uploading: false, _url: fmt.fullUrl(a.path) });
              }).catch(() => this._dropAsset(key));
            }
          }).catch(() => this._dropAsset(key));
        });
      },
    });
  },
  _patchAsset(key, patch) {
    const i = this.data.assets.findIndex((x) => x.key === key);
    if (i < 0) return;
    this.setData({ [`assets[${i}]`]: { ...this.data.assets[i], ...patch } });
  },
  _dropAsset(key) {
    this.setData({ assets: this.data.assets.filter((x) => x.key !== key) });
  },
  delAsset(e) {
    const a = this.data.assets[e.currentTarget.dataset.i];
    if (!a || (!a.id && !a.key)) return;
    if (a.id) {
      wx.showModal({
        title: '移除素材', content: '从项目里移除这张图？（素材库里的原图不删）',
        success: (r) => {
          if (!r.confirm) return;
          api.delProjectAsset(this.data.pid, a.id).then(() => this.reload()).catch(() => {});
        },
      });
    } else {
      this._dropAsset(a.key);
    }
  },

  // ================= 语音说需求 → AI 整理进提示词（立项与改稿都能用） =================
  onVoiceInput(e) { this.setData({ voiceDraft: e.detail.value }); },
  voiceStart() {
    if (!this.data.speechOn) {
      wx.showToast({ title: '未启用语音插件（公众平台添加免费的「微信同声传译」后重进）', icon: 'none', duration: 3000 });
      return;
    }
    if (this.data.recording) return;
    this.setData({ recording: true });
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    const before = this.data.voiceDraft;
    speech.startHold({
      onInterim: (t) => this.setData({ voiceDraft: (before ? before + ' ' : '') + t }),
      onFinal: (t) => {
        this.setData({ recording: false });
        if (!t) wx.showToast({ title: '没听到话，按住说、别只点一下', icon: 'none' });
      },
      onError: (msg) => {
        this.setData({ recording: false });
        wx.showToast({ title: msg, icon: 'none', duration: 3000 });
      },
    });
  },
  voiceEnd() {
    if (!this.data.recording) return;
    speech.stopHold();
    this.setData({ recording: false });
  },
  polish() {
    const src = (this.data.voiceDraft || this.data.brief || '').trim();
    if (!src) { wx.showToast({ title: '先说两句或打点字', icon: 'none' }); return; }
    this.setData({ polishing: true });
    api.polishPrompt(src).then((d) => this._applyPolished(d.prompt || '')).catch((e) => {
      const local = localStructure(src);
      wx.showModal({
        title: 'AI 在线整理暂不可用',
        content: ((e && e.message) || '接口失败') + '\n\n先用本地模板整理了一版，可继续编辑。要写入吗？',
        confirmText: '写入', cancelText: '算了',
        success: (r) => { if (r.confirm) this._applyPolished(local); },
      });
    }).then(() => this.setData({ polishing: false }));
  },
  _applyPolished(text) {
    if (!text) return;
    const cur = (this.data.brief || '').trim();
    const put = () => this.setData({ brief: text, polishedBackup: cur || this.data.polishedBackup });
    if (!cur) { put(); return; }
    wx.showModal({
      title: '覆盖当前提示词？', content: 'AI 整理稿会替换输入框文字；原文自动备份，可一键恢复。',
      confirmText: '替换', success: (r) => { if (r.confirm) put(); },
    });
  },
  restoreBrief() { this.setData({ brief: this.data.polishedBackup, polishedBackup: '' }); },

  // ================= 跑步骤 =================
  // 选完分镜后切引擎：只影响「出成片」那一步。
  pickRenderer(e) { this.setData({ renderer: e.currentTarget.dataset.r }); },

  runStep(e) {
    if (!guard.requireWrite(`/pages/project/project?id=${this.data.pid}`)) return;
    const kind = e.currentTarget.dataset.kind;
    const extra = { storyboard: '出分镜', video: '出成片', copy: '出平台文案' }[kind];
    if (kind === 'video' && !this.data.steps.some((s) => s.kind === 'storyboard' && s.status === 'done')) {
      wx.showToast({ title: '先跑「出分镜」并确认一版', icon: 'none' });
      return;
    }
    this.setData({ busyKind: kind });
    const body = { kind };
    if (this.data.stepPrompt.trim()) body.prompt = this.data.stepPrompt.trim();
    if (kind === 'video') body.renderer = this.data.renderer;
    if (e.currentTarget.dataset.stepId) body.storyboard_step_id = Number(e.currentTarget.dataset.stepId);
    api.runProjectStep(this.data.pid, body).then(() => {
      wx.showToast({ title: extra + '已开工，跑完自动刷新', icon: 'none', duration: 2500 });
      this.setData({ stepPrompt: '' });
      this.reload();
    }).catch(() => {}).then(() => this.setData({ busyKind: '' }));
  },
  retryStep(e) {
    if (!guard.requireWrite(`/pages/project/project?id=${this.data.pid}`)) return;
    api.retryProjectStep(e.currentTarget.dataset.id).then(() => {
      wx.showToast({ title: '已重跑，历史保留', icon: 'none' });
      this.reload();
    }).catch(() => {});
  },

  // 分镜查看/手改
  openSb(e) {
    const s = this.data.steps.find((x) => x.id === e.currentTarget.dataset.id);
    if (!s || !s.result) return;
    let pretty = s.result;
    try { pretty = JSON.stringify(JSON.parse(s.result), null, 1); } catch { /* 原样展示 */ }
    this.setData({ sbVisible: true, sbStepId: s.id, sbText: pretty, sbReadonly: !this.data.canWrite });
  },
  closeSb() { this.setData({ sbVisible: false }); },
  onSbInput(e) { this.setData({ sbText: e.detail.value }); },
  saveSb() {
    const t = this.data.sbText.trim();
    if (!t) return;
    try { JSON.parse(t); } catch { wx.showToast({ title: 'JSON 不合法，别改坏了', icon: 'none' }); return; }
    api.saveStepResult(this.data.sbStepId, JSON.stringify(JSON.parse(t))).then(() => {
      wx.showToast({ title: '已保存，出成片时选「用这版」', icon: 'none' });
      this.setData({ sbVisible: false });
      this.reload();
    }).catch(() => {});
  },
  videoFromSb(e) {
    const id = this.data.sbStepId || e.currentTarget.dataset.id;
    this.setData({ sbVisible: false });
    this._runVideoWith(id);
  },
  _runVideoWith(stepId) {
    if (!guard.requireWrite(`/pages/project/project?id=${this.data.pid}`)) return;
    this.setData({ busyKind: 'video' });
    api.runProjectStep(this.data.pid, { kind: 'video', storyboard_step_id: stepId, renderer: this.data.renderer }).then(() => {
      wx.showToast({ title: '按这版分镜开渲（渲染约几分钟）', icon: 'none', duration: 2500 });
      this.reload();
    }).catch(() => {}).then(() => this.setData({ busyKind: '' }));
  },

  goReview() {
    wx.switchTab({ url: '/pages/pipeline/pipeline' });
    // 落到 pipeline 页后由用户点「待放行」；tabBar 页无法带参，先提示。
    wx.showToast({ title: '切到「待放行」页签看稿', icon: 'none' });
  },
  copyVideoUrl(e) {
    let url = e.currentTarget.dataset.url || '';
    if (!url) return;
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'dl=1';
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '已复制下载链接', icon: 'none' }) });
  },
  archiveTap() {
    wx.showModal({
      title: '归档项目', content: '归档后项目不再出现在列表首页，产物不受影响。',
      success: (r) => { if (r.confirm) this.setProjectStatus('archived'); },
    });
  },
});
