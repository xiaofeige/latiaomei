// 写操作页面的统一守卫。只读身份进编辑页只会白忙一场，直接拦在门口。
const session = require('./session');

/**
 * @param {string} backUrl 没有上一页时回落到哪个 tab
 * @returns {boolean} true 表示可继续（有写权限）
 */
function requireWrite(backUrl) {
  if (session.canWrite()) return true;
  wx.showToast({ title: '你是只读身份，需要主人在「成员管理」里放行', icon: 'none', duration: 2500 });
  setTimeout(() => {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: backUrl || '/pages/dashboard/dashboard' });
  }, 600);
  return false;
}

module.exports = { requireWrite };
