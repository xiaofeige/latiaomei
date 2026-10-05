// 后台接口层：对应 src/server/internal/httpapi/admin.go 与 auth.go。
// 页面只调这里，路径集中维护。
const { get, post, put, del, request } = require('./request');

module.exports = {
  // ---- 微信身份 ----
  // 登录本身走 utils/wxauth.js（静默、无页面），这里只留“我是谁 / 成员 / 审计”。
  me: () => get('/admin/wx/me', {}, { silent: true }),
  logout: () => post('/admin/wx/logout', {}, { silent: true }),
  members: () => get('/admin/wx/members'),
  memberAction: (openid, action, note) => post('/admin/wx/members', { openid, action, note: note || '' }, { loading: true }),
  audit: (size) => get('/admin/wx/audit', size ? { size } : {}),

  // ---- 概览 / 统计 ----
  overview: (days) => get('/admin/overview', days ? { days } : {}),
  analytics: (date) => get('/admin/analytics', date ? { date } : {}),

  // ---- 点评 ----
  listReviews: (p) => get('/admin/reviews', p),
  getReview: (id) => get(`/admin/reviews/${id}`),
  createReview: (body) => post('/admin/reviews', body, { loading: true }),
  updateReview: (id, body) => put(`/admin/reviews/${id}`, body, { loading: true }),
  deleteReview: (id) => del(`/admin/reviews/${id}`, {}, { loading: true }),
  setReviewStatus: (id, status) => post(`/admin/reviews/${id}/status`, { status }, { loading: true }),
  setFeatured: (id) => post(`/admin/reviews/${id}/featured`, {}, { loading: true }),
  // 首页转盘开关：on=false 这道菜就不在转盘里转，内容本身照发。
  setWheel: (id, on) => post(`/admin/reviews/${id}/wheel`, { on }, { loading: true }),
  // 排行榜拖拽调序：ids 就是新的 1..N 名次（带 kind 防串榜）。
  saveRanks: (p) => post('/admin/reviews/rank', { kind: p.kind, ids: p.ids }, { loading: true }),

  // ---- 店铺 ----
  listShops: (p) => get('/admin/shops', p),
  saveShop: (body) => (body.id ? put(`/admin/shops/${body.id}`, body, { loading: true }) : post('/admin/shops', body, { loading: true })),
  deleteShop: (id) => del(`/admin/shops/${id}`, {}, { loading: true }),

  // ---- 标签 ----
  listTastes: (kind) => get('/admin/tastes', kind ? { kind } : {}),
  saveTaste: (body) => (body.id ? put(`/admin/tastes/${body.id}`, body, { loading: true }) : post('/admin/tastes', body, { loading: true })),
  deleteTaste: (id) => del(`/admin/tastes/${id}`, {}, { loading: true }),

  // ---- 许愿池（v8：粉丝许愿 → 分析 → 翻牌转指令）----
  wishes: (p) => get('/admin/wishes', p || {}),
  wishStatus: (id, status, note) => post(`/admin/wishes/${id}/status`, { status, note: note || '' }, { loading: true }),
  wishToDirective: (id, title) => post(`/admin/wishes/${id}/directive`, { title: title || '' }, { loading: true }),
  deleteWish: (id) => del(`/admin/wishes/${id}`, {}, { loading: true }),

  // ---- 站点设置 ----
  getSettings: () => get('/admin/settings'),
  saveSettings: (settings) => put('/admin/settings', { settings }, { loading: true }),

  // ---- 上传 / 图片库 ----
  listUploads: (size) => get('/admin/uploads', size ? { size } : {}),
  deleteUpload: (id) => del(`/admin/uploads/${id}`, {}, { loading: true }),

  // ---- 运维 ----
  maintenance: (action) => post('/admin/maintenance', { action }, { loading: true }),
  health: () => request({ path: '/healthz', method: 'GET', auth: false, silent: true, header: {} }),

  // ---- AI 流水线（v9：发任务 → 四平台文案人审 → 放行自动发）----
  // mission：选一条内容 + 若干平台，入队 social_gen；worker 只产待审文案，不直接发。
  mission: (body) => post('/admin/missions', body, { loading: true }),
  socialItems: (p) => get('/admin/social-items', p || {}),
  socialSave: (id, body) => post(`/admin/social-items/${id}/save`, body, { loading: true }),
  socialApprove: (id) => post(`/admin/social-items/${id}/approve`, {}, { loading: true }),
  socialReject: (id, note) => post(`/admin/social-items/${id}/reject`, { note: note || '' }, { loading: true }),
  pipeTasks: (p) => get('/admin/tasks', p || {}),
  taskAction: (id, action) => post(`/admin/tasks/${id}/${action}`, {}, { loading: true }),
  // 手动补发非发布类任务（video/gzh/wxpush/draft/social_gen）。
  enqueueTask: (type, reviewId) => post('/admin/tasks', { type, review_id: reviewId }, { loading: true }),
  directives: (status) => get('/admin/directives', status ? { status } : {}),
  addDirective: (body) => post('/admin/directives', body, { loading: true }),
  directiveStatus: (id, status, note) => post(`/admin/directives/${id}/status`, { status, note: note || '' }, { loading: true }),

  // ---- v10 视频工坊（AI Tab）----
  // 语音转写/草稿描述 → LLM 结构化成规范制作提示词。失败不弹 toast，页内有本地兜底。
  polishPrompt: (text) => post('/admin/ai/polish', { text, kind: 'video' }, { silent: true }),
  // 下单做视频（v10 旧通道，已被 v13 项目制取代；服务端保留兼容）。
  videoMission: (body) => post('/admin/video-missions', body, { loading: true }),

  // ---- v13 项目制内容生产：立项 → 工作区加图/改提示词 → 分步跑（出分镜/出成片/出文案）----
  projects: (p) => get('/admin/projects', p || {}),
  createProject: (body) => post('/admin/projects', body, { loading: true }),
  project: (id) => get(`/admin/projects/${id}`),
  saveProject: (id, body) => put(`/admin/projects/${id}`, body, { loading: true }),
  deleteProject: (id) => del(`/admin/projects/${id}`, {}, { loading: true }),
  addProjectAsset: (id, body) => post(`/admin/projects/${id}/assets`, body, { loading: true }),
  delProjectAsset: (id, aid) => del(`/admin/projects/${id}/assets/${aid}`, {}, { loading: true }),
  runProjectStep: (id, body) => post(`/admin/projects/${id}/steps`, body, { loading: true }),
  saveStepResult: (id, result) => post(`/admin/project-steps/${id}/save`, { result }, { loading: true }),
  retryProjectStep: (id) => post(`/admin/project-steps/${id}/retry`, {}, { loading: true }),

  // 上传单图：走 wx.uploadFile，字段名必须是 file，鉴权用 Authorization 头。
  upload: require('./upload').upload,
  // 上传非图片素材（视频/音频/文档），同一套鉴权；上限服务端 120MB。
  uploadAny: require('./upload').uploadAny,
};
