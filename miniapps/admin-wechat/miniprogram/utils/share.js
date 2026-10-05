// 分享：后台小程序要能把同事拉进来，管理员不止一个人。
// 打开分享卡片的人用各自微信身份静默登录：
//   · 第一个进来的自动成为 owner；
//   · 之后进来的默认 pending（只读），由 owner/管理员在「成员管理」里放行。
// 所以分享文案可以放心写，泄不了写权限。
const TITLE = '辣条妹的御膳房 · 只做杭州美食（微信身份即账号）';

function msg(path) {
  return { title: TITLE, path: path || '/pages/dashboard/dashboard' };
}

function timeline() {
  return { title: TITLE };
}

module.exports = { msg, timeline };
