// 图片/素材上传：wx.uploadFile 独立于 wx.request，单独封装。
// 后端字段名固定为 file（见 upload.go），Bearer 通道不需要 CSRF。
const config = require('../config');
const session = require('./session');
const wxauth = require('./wxauth');

function doUpload(filePath, pathName, timeout) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: config.API_BASE + config.API_PREFIX + pathName,
      filePath,
      name: 'file',
      header: { Authorization: 'Bearer ' + session.getToken() },
      timeout: timeout || config.REQUEST_TIMEOUT,
      success(res) {
        let body = res.data;
        try { body = JSON.parse(res.data); } catch (e) { /* 原样保留 */ }
        if (res.statusCode === 401) { const e = new Error('会话失效'); e.expired = true; reject(e); return; }
        if (body && body.ok) { resolve(body.data); return; }
        reject(new Error((body && body.error) || `上传失败(${res.statusCode})`));
      },
      fail(err) { reject(err); },
    });
  });
}

// 通用：先保会话，过期重登再传一次，不让用户白选一张图。
function withSession(pathName, filePath, timeout) {
  return wxauth.ensure()
    .then(() => doUpload(filePath, pathName, timeout))
    .catch((e) => {
      if (e && e.expired) return wxauth.relogin().then(() => doUpload(filePath, pathName, timeout));
      throw e;
    });
}

function upload(filePath) {
  wx.showLoading({ title: '上传中', mask: true });
  return withSession('/admin/upload', filePath)
    .then((d) => { wx.hideLoading(); return d; })
    .catch((e) => {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '上传失败', icon: 'none' });
      throw e;
    });
}

// 非图片素材（视频/音频/文档）透传上传：大文件，超时放宽到 5 分钟。
function uploadAny(filePath) {
  wx.showLoading({ title: '上传中', mask: true });
  return withSession('/admin/upload/file', filePath, 300000)
    .then((d) => { wx.hideLoading(); return d; })
    .catch((e) => {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '上传失败', icon: 'none' });
      throw e;
    });
}

module.exports = { upload, uploadAny };
