'use strict';
// 与 Go 后端 /api/pipeline/* 的对话层。所有响应形如 {ok, data|error}。
const { CFG } = require('./env');

async function req(method, p, body) {
  const res = await fetch(CFG.apiBase + p, {
    method,
    headers: {
      authorization: 'Bearer ' + CFG.token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let j;
  try { j = await res.json(); } catch { throw new Error(`pipeline api ${p}: HTTP ${res.status} 非 JSON`); }
  if (!j.ok) throw new Error(`pipeline api ${p}: ${j.error || res.status}`);
  return j.data;
}

module.exports = {
  poll: (limit = 1, maxAttempts = 3) => req('GET', `/api/pipeline/poll?limit=${limit}&max_attempts=${maxAttempts}`),
  claim: (id) => req('POST', `/api/pipeline/tasks/${id}/claim`),
  finish: (id, status, result = '', error = '') => req('POST', `/api/pipeline/tasks/${id}/finish`, { status, result, error }),
  enqueue: (type, reviewId = 0, runAfter = 0, payload = null) =>
    req('POST', '/api/pipeline/tasks', { type, review_id: reviewId, run_after: runAfter, ...(payload ? { payload } : {}) }),
  getReview: (id) => req('GET', `/api/pipeline/reviews/${id}`),
  listReviews: (qs = '') => req('GET', `/api/pipeline/reviews${qs}`),
  createReview: (draft) => req('POST', '/api/pipeline/reviews', draft),
  directives: () => req('GET', '/api/pipeline/directives'),
  directiveDone: (id, status, note) => req('POST', `/api/pipeline/directives/${id}/done`, { status, note }),
  subscribers: (channel, limit = 200) => req('GET', `/api/pipeline/subscribers?channel=${channel}&limit=${limit}`),
  consume: (channel, openid) => req('POST', '/api/pipeline/subscribers/consume', { channel, openid }),
  settings: () => req('GET', '/api/pipeline/settings'),
  // 已完成任务列表（产能统计用）
  tasks: (qs) => req('GET', `/api/pipeline/tasks?${qs}`),
  // ---- v9 社媒待审文案：worker 只能产 pending / 回读 / 回填结果，放行权在人 ----
  createSocialItem: (item) => req('POST', '/api/pipeline/social-items', item),
  getSocialItem: (id) => req('GET', `/api/pipeline/social-items/${id}`),
  socialItemResult: (id, status, result = '', note = '') =>
    req('POST', `/api/pipeline/social-items/${id}/result`, { status, result, note }),
  // ---- v13 项目制：读项目全貌 / 回填步骤结果 ----
  getProject: (id) => req('GET', `/api/pipeline/projects/${id}`),
  finishProjectStep: (id, status, result = '', error = '', note = '') =>
    req('POST', `/api/pipeline/project-steps/${id}/finish`, { status, result, error, note }),
};
