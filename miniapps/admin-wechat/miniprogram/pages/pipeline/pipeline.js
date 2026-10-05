// 创作工作台（Tab3，v13）：内容生产改成「项目制」——一条视频/一组文案 = 一个项目，
// 在工作区里反复加素材、改提示词、分步跑（出分镜→改分镜→出成片→出文案），
// 不再是一键流水线。本页只留：项目列表 / 产文案 / 待放行 / 素材库 / 创作目标；
// 项目工作区在 pages/project。队列监控数据在概览 Tab（pages/tasks）。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const session = require('../../utils/session');
const guard = require('../../utils/guard');

const TABS = [
  { code: 'projects', label: '项目' },
  { code: 'mission', label: '产文案' },
  { code: 'review', label: '待放行' },
  { code: 'lib', label: '素材库' },
  { code: 'cmds', label: '创作目标' },
];
const R_FILTERS = [
  { code: 'pending', label: '待审' },
  { code: 'approved', label: '已放行' },
  { code: 'published', label: '已发布' },
  { code: 'rejected', label: '已驳回' },
  { code: 'failed', label: '发布失败' },
  { code: 'all', label: '全部' },
];
const TS_LABEL = { pending: '排队中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' };
const PLATFORMS = [
  { code: 'douyin', label: '抖音', tip: '视频（工坊挂成片）' },
  { code: 'xiaohongshu', label: '小红书', tip: '图文·主战场' },
  { code: 'zhihu', label: '知乎', tip: '长文' },
  { code: 'weibo', label: '微博', tip: '短图文' },
];
const DKINDS = [
  { code: 'topic', label: '点菜（做什么题）' },
  { code: 'style', label: '口径（怎么写）' },
  { code: 'promo', label: '推广（商单/直播）' },
  { code: 'block', label: '禁做（别碰）' },
];

let MAT_SEQ = 0;

function parseArr(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

Page({
  onShareAppMessage() { return require('../../utils/share').msg('/pages/pipeline/pipeline'); },

  data: {
    tabs: TABS, tab: 'projects',
    canWrite: false, loading: true,
    pendingCount: 0, workerOn: true,
    queue: { pending: 0, running: 0, failed: 0 },

    // —— 项目列表 ——
    projects: [],

    // —— 待放行 ——
    rFilters: R_FILTERS, rFilter: 'pending',
    items: [], shownItems: [], vOnly: false, rSum: {},

    // —— 改稿弹层 ——
    editVisible: false, editId: 0, editTitle: '', editBody: '', editTags: '', editPlatform: '',

    // —— 素材库 ——
    libImages: [], libStaging: [], libLoading: false, libSum: '',

    // —— 产文案（原派任务）——
    platforms: PLATFORMS.map((p) => ({ ...p, on: p.code !== 'douyin' })),
    reviews: [], reviewNames: [], reviewIdx: -1, missionNote: '',

    // —— 创作目标 ——
    dKinds: DKINDS, directives: [], dTitle: '', dBrief: '', dKindIdx: 0, dVisible: false,
  },

  onShow() {
    this.setData({ canWrite: session.canWrite() });
    this.reload();
  },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },

  reload() {
    this.setData({ loading: true });
    this.loadQueue();
    const t = this.data.tab;
    let p;
    if (t === 'review') p = this.loadReview();
    else if (t === 'cmds') p = this.loadDirectives();
    else if (t === 'mission') p = this.loadMissionReviews();
    else if (t === 'lib') p = this.loadLib();
    else p = this.loadProjects();
    return p.then(() => this.setData({ loading: false })).catch(() => this.setData({ loading: false }));
  },

  // 队列水位一行：只展示入口，监控细节在 pages/tasks（从概览 Tab 进）。
  loadQueue() {
    return api.pipeTasks({ status: 'all', limit: 1 }).then((d) => {
      const sum = d.summary || {};
      this.setData({
        queue: { pending: sum.pending || 0, running: sum.running || 0, failed: sum.failed || 0 },
        workerOn: d.pipeline_on !== false,
        pendingCount: (d.social_summary || {}).pending || this.data.pendingCount,
      });
    }).catch(() => {});
  },
  goTasks() { wx.navigateTo({ url: '/pages/tasks/tasks' }); },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.code }, () => this.reload());
  },
  goReviewTab() {
    this.setData({ tab: 'review', rFilter: 'all', vOnly: true }, () => this.reload());
  },
  noop() {},

  // ================= 项目（v13 项目制：一条视频/一组文案 = 一个项目） =================
  loadProjects() {
    return api.projects({ limit: 50 }).then((d) => {
      const projects = (d.projects || []).map((x) => ({
        ...x,
        _time: fmt.ago(x.updated_at),
        _last: x.last_step_label ? `${x.last_step_label}·${({ pending: '排队中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' })[x.last_step_status] || x.last_step_status}` : '还没开跑',
      }));
      this.setData({ projects });
    });
  },
  goProject(e) {
    wx.navigateTo({ url: `/pages/project/project?id=${e.currentTarget.dataset.id}` });
  },
  newProject() {
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    wx.navigateTo({ url: '/pages/project/project?id=0' });
  },

  // ================= 素材库（图片台账：传图、引用、删除） =================
  loadLib() {
    this.setData({ libLoading: true });
    return api.listUploads(120).then((d) => {
      const imgs = (d.items || []).map((x) => ({
        ...x,
        _url: fmt.fullUrl(x.thumb || x.path),
        _date: fmt.date(x.created_at),
        _size: fmt.bytes(x.bytes),
      }));
      const st = d.storage || {};
      this.setData({
        libImages: imgs,
        libLoading: false,
        libSum: st.upload_files ? `${st.upload_files} 张 / ${fmt.bytes(st.upload_bytes)}` : '0 张',
      });
    }).catch(() => this.setData({ libLoading: false }));
  },
  libPick() {
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    wx.chooseMedia({
      count: 9, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        const add = res.tempFiles.map((f) => ({
          key: `u${++MAT_SEQ}`, _preview: f.tempFilePath, uploading: true,
        }));
        this.setData({ libStaging: this.data.libStaging.concat(add) });
        let done = 0;
        add.forEach((cell, i) => {
          api.upload(res.tempFiles[i].tempFilePath).then(() => {
            done += 1;
            this._dropMat('libStaging', cell.key);
            if (done === add.length) {
              wx.showToast({ title: `已入库 ${done} 张`, icon: 'success' });
              this.setData({ libStaging: [] });
              this.loadLib();
            }
          }).catch(() => {
            this._dropMat('libStaging', cell.key);
          });
        });
      },
    });
  },
  libUse(e) {
    const it = this.data.libImages[e.currentTarget.dataset.i];
    if (!it) return;
    const acts = ['挂到项目…', '复制文件路径'];
    if (this.data.canWrite) acts.push('从库里删除');
    wx.showActionSheet({
      itemList: acts,
      success: (r) => {
        if (r.tapIndex === 0) {
          // 挑一个进行中的项目，把库里的图挂成它的素材；挂完直接进工作区。
          api.projects({ status: 'open', limit: 50 }).then((d) => {
            const list = (d.projects || []);
            if (!list.length) { wx.showToast({ title: '还没有进行中的项目，先去「项目」立一个', icon: 'none' }); return; }
            wx.showActionSheet({
              itemList: list.slice(0, 6).map((x) => x.title),
              success: (r2) => {
                const p = list[r2.tapIndex];
                if (!p) return;
                api.addProjectAsset(p.id, { path: it.path, kind: 'image' }).then(() => {
                  wx.showToast({ title: '已挂进项目素材', icon: 'success' });
                  wx.navigateTo({ url: `/pages/project/project?id=${p.id}` });
                }).catch(() => {});
              },
            });
          }).catch(() => {});
        } else if (r.tapIndex === 1) {
          wx.setClipboardData({ data: it.path });
        } else if (r.tapIndex === 2) {
          if (it.used_by) { wx.showToast({ title: '这张图正被内容引用，删不了', icon: 'none' }); return; }
          wx.showModal({
            title: '删除图片', content: `从库里删掉 ${it.path}？不可恢复。`,
            success: (m) => {
              if (!m.confirm) return;
              api.deleteUpload(it.id).then(() => {
                wx.showToast({ title: '已删除', icon: 'success' });
                this.loadLib();
              }).catch(() => {});
            },
          });
        }
      },
    });
  },

  // ================= 待放行（成片/文案稿审核） =================
  loadReview() {
    return api.socialItems({ status: this.data.rFilter, limit: 50 }).then((d) => {
      const items = (d.items || []).map((it) => {
        const tags = parseArr(it.tags);
        const images = parseArr(it.images).map((p) => fmt.fullUrl(p));
        return {
          ...it,
          _tags: tags, _images: images, _time: fmt.ago(it.created_at),
          _videoUrl: it.video ? fmt.fullUrl(it.video) : '',
          // WXML 里不写转义拼接（编译不过），复制用文本在 JS 里拼好。
          _copy: [it.title, it.body].filter(Boolean).join('\n'),
          _body_short: it.body.length > 88 ? it.body.slice(0, 88) + '…' : it.body,
          _open: false,
        };
      });
      this.setData({
        items, rSum: d.summary || {}, pendingCount: (d.summary || {}).pending || 0,
        shownItems: this.data.vOnly ? items.filter((x) => x.video) : items,
      });
    });
  },
  switchRFilter(e) {
    this.setData({ rFilter: e.currentTarget.dataset.code }, () => this.loadReview());
  },
  toggleVOnly() {
    const v = !this.data.vOnly;
    this.setData({ vOnly: v, shownItems: v ? this.data.items.filter((x) => x.video) : this.data.items });
  },
  _idxOf(id) { return this.data.items.findIndex((x) => x.id === id); },
  toggleOpen(e) {
    const i = this._idxOf(e.currentTarget.dataset.id);
    if (i < 0) return;
    this.setData({ [`items[${i}]._open`]: !this.data.items[i]._open });
    this._syncShown();
  },
  _syncShown() {
    this.setData({ shownItems: this.data.vOnly ? this.data.items.filter((x) => x.video) : this.data.items });
  },
  approve(e) {
    const { id, platform, dish } = e.currentTarget.dataset;
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    wx.showModal({
      title: '审核通过·自动发布',
      content: `《${dish}》的${platform}稿将进入自动发布队列（发布前反悔：驳回即可撤回未执行的任务）。确认放行？`,
      confirmText: '放行',
      success: (r) => {
        if (!r.confirm) return;
        api.socialApprove(id).then(() => {
          wx.showToast({ title: '已放行，worker 会去发', icon: 'none', duration: 2500 });
          this.loadReview();
        }).catch(() => {});
      },
    });
  },
  reject(e) {
    const { id, dish } = e.currentTarget.dataset;
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    wx.showModal({
      title: `驳回《${dish}》`,
      editable: true, placeholderText: '驳回原因（AI 重产时会参考，可留空）',
      success: (r) => {
        if (!r.confirm) return;
        api.socialReject(id, (r.content || '').trim()).then(() => {
          wx.showToast({ title: '已驳回', icon: 'success' });
          this.loadReview();
        }).catch(() => {});
      },
    });
  },
  copyText(e) { wx.setClipboardData({ data: e.currentTarget.dataset.text }); },

  // 成片保存到相册：方便一键搬运到还没打通自动发布凭证的平台（如抖音号）。
  // 复制成片源文件直链（带 ?dl=1，服务端按附件返回）：电脑浏览器粘贴即下载 mp4，自行传抖音。
  copyVideoUrl(e) {
    let url = e.currentTarget.dataset.url || '';
    if (!url) { wx.showToast({ title: '没有可用的成片地址', icon: 'none' }); return; }
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'dl=1';
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '已复制：电脑浏览器打开即下载成片', icon: 'none', duration: 2500 }),
    });
  },

  saveVideo(e) {
    const url = e.currentTarget.dataset.url;
    wx.showLoading({ title: '下载成片', mask: true });
    wx.downloadFile({
      url,
      success: (res) => {
        wx.saveVideoToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: '成片已存相册', icon: 'success' }),
          fail: () => wx.showToast({ title: '保存失败：相册权限？', icon: 'none' }),
        });
      },
      fail: () => wx.showToast({ title: '成片下载失败', icon: 'none' }),
      complete: () => wx.hideLoading(),
    });
  },

  // 改稿弹层
  openEdit(e) {
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    const it = this.data.items[this._idxOf(e.currentTarget.dataset.id)];
    if (!it) return;
    this.setData({
      editVisible: true, editId: it.id, editTitle: it.title,
      editBody: it.body, editTags: it._tags.join(' '), editPlatform: it.platform_label,
    });
  },
  closeEdit() { this.setData({ editVisible: false }); },
  onEditTitle(e) { this.setData({ editTitle: e.detail.value }); },
  onEditBody(e) { this.setData({ editBody: e.detail.value }); },
  onEditTags(e) { this.setData({ editTags: e.detail.value }); },
  saveEdit() {
    const { editId, editTitle, editBody, editTags } = this.data;
    if (!editBody.trim()) { wx.showToast({ title: '正文不能清空', icon: 'none' }); return; }
    api.socialSave(editId, {
      title: editTitle.trim(), body: editBody,
      tags: editTags.split(/[\s,，、#]+/).filter(Boolean),
    }).then(() => {
      wx.showToast({ title: '已保存（放行前后都算数）', icon: 'none' });
      this.setData({ editVisible: false });
      this.loadReview();
    }).catch(() => {});
  },

  // ================= 产文案（给内容派平台稿任务） =================
  loadMissionReviews() {
    return api.listReviews({ status: 'published', sort: 'new', size: 50 }).then((d) => {
      const reviews = d.items || [];
      this.setData({
        reviews,
        reviewNames: reviews.map((r) => `${r.dish} · ${r.shop ? r.shop.name : ''}（${fmt.date(r.published_at)}）`),
        reviewIdx: this.data.reviewIdx >= 0 && this.data.reviewIdx < reviews.length ? this.data.reviewIdx : -1,
      });
    });
  },
  onPickReview(e) { this.setData({ reviewIdx: Number(e.detail.value) }); },
  togglePlatform(e) {
    const i = e.currentTarget.dataset.i;
    const key = `platforms[${i}].on`;
    this.setData({ [key]: !this.data.platforms[i].on });
  },
  onMissionNote(e) { this.setData({ missionNote: e.detail.value }); },
  submitMission() {
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    const { reviewIdx, reviews, platforms, missionNote } = this.data;
    if (reviewIdx < 0 || !reviews[reviewIdx]) { wx.showToast({ title: '先选一条内容', icon: 'none' }); return; }
    const codes = platforms.filter((p) => p.on).map((p) => p.code);
    if (!codes.length) { wx.showToast({ title: '至少选一个平台', icon: 'none' }); return; }
    api.mission({ review_id: reviews[reviewIdx].id, platforms: codes, note: missionNote.trim() }).then((d) => {
      wx.showModal({
        title: d.added ? '任务已下达' : '已有未完成任务',
        content: d.added
          ? `AI 会给《${reviews[reviewIdx].dish}》产 ${codes.length} 条平台文案，好了会亮在「待放行」角标上。`
          : (d.hint || '这条内容已有生成任务在排队'),
        showCancel: false,
        success: () => this.setData({ tab: 'review', rFilter: 'pending' }, () => this.reload()),
      });
    }).catch(() => {});
  },

  // ================= 创作目标（原选题指令） =================
  loadDirectives() {
    return api.directives('all').then((d) => {
      const list = (d.directives || []).map((x) => ({ ...x, kind_text: ({ topic: '点菜', style: '口径', promo: '推广', block: '禁做' })[x.kind] || x.kind, _time: fmt.ago(x.created_at) }));
      this.setData({ directives: list, dVisible: false });
    });
  },
  showDirectiveForm() {
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    this.setData({ dVisible: true });
  },
  hideDirectiveForm() { this.setData({ dVisible: false }); },
  onDTitle(e) { this.setData({ dTitle: e.detail.value }); },
  onDBrief(e) { this.setData({ dBrief: e.detail.value }); },
  onDKind(e) { this.setData({ dKindIdx: Number(e.detail.value) }); },
  addDirective() {
    const { dTitle, dBrief, dKindIdx, dKinds } = this.data;
    if (!dTitle.trim()) { wx.showToast({ title: '指令标题不能空', icon: 'none' }); return; }
    api.addDirective({ title: dTitle.trim(), brief: dBrief.trim(), kind: dKinds[dKindIdx].code }).then(() => {
      this.setData({ dTitle: '', dBrief: '' });
      wx.showToast({ title: '指令已下达', icon: 'success' });
      this.loadDirectives();
    }).catch(() => {});
  },
  // 一键把目标口径带进新项目（工作区页预填，可继续改）。
  useGoalInStudio(e) {
    const d = this.data.directives.find((x) => x.id === e.currentTarget.dataset.id);
    if (!d) return;
    getApp().globalData.pendingProjectBrief = `【对齐目标】${d.title}${d.brief ? '：' + d.brief : ''}`;
    wx.navigateTo({ url: '/pages/project/project?id=0' });
  },
  doneDirective(e) {
    const { id, to } = e.currentTarget.dataset;
    if (!guard.requireWrite('/pages/pipeline/pipeline')) return;
    wx.showModal({
      title: to === 'done' ? '标记完成' : '取消指令', editable: true, placeholderText: '执行说明（选填）',
      success: (r) => {
        if (!r.confirm) return;
        api.directiveStatus(id, to, (r.content || '').trim()).then(() => this.loadDirectives()).catch(() => {});
      },
    });
  },
});
