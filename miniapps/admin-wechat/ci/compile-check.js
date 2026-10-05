// 真机级编译校验：跑微信同一套编译器，能在上传前抓出 WXML/WXSS/JS 编译错误。
// 用法：node ci/compile-check.js
//
// 需要 project.config.json 里已填真实 appid，且上级目录有 private.<appid>.key
// （编译器要向微信取项目属性，纯离线跑不了）。缺凭据时本脚本会明确退出，不报假错。
const ci = require('miniprogram-ci');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const appid = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8')).appid;
  } catch (e) { return ''; }
})();

if (!appid || appid === 'touristappid') {
  console.log('○ 跳过编译校验：appid 还是占位值 touristappid。');
  console.log('  填好真实 AppID 并放上传入 private.<appid>.key 后再跑本脚本。');
  process.exit(0);
}
const keyPath = path.join(ROOT, `private.${appid}.key`);
if (!fs.existsSync(keyPath)) {
  console.log(`○ 跳过编译校验：找不到密钥 ${keyPath}`);
  console.log('  到微信公众平台 → 开发设置 → 小程序代码上传 下载后放到 admin-wechat/ 下。');
  process.exit(0);
}

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: path.join(ROOT, 'miniprogram'),
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*'],
});

ci.getCompiledResult({ project, version: '0.0.0', test: true })
  .then((res) => {
    const keys = Object.keys(res || {});
    if (!keys.length) { console.log('✗ 编译没有任何产出，检查源码结构'); process.exit(1); }
    // test 模式返回的是逐文件转译产物（app.js / pages/*），
    // 打包后的 app-service.js 只在真正 preview/upload 时才产生，这里不能拿它当判据。
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
    const missing = [];
    ['app.js', 'app.json', 'app.wxss'].forEach((f) => { if (!keys.includes(f)) missing.push(f); });
    (appJson.pages || []).forEach((p) => {
      ['.js', '.wxml'].forEach((ext) => { if (!keys.includes(p + ext)) missing.push(p + ext); });
    });
    if (missing.length) {
      console.log(`✗ 编译产物缺少 ${missing.length} 项：${missing.slice(0, 8).join(', ')}`);
      process.exit(1);
    }
    const total = keys.reduce((s, k) => s + Buffer.byteLength(res[k]), 0);
    console.log(`✓ 编译通过：${keys.length} 个产物，合计 ${(total / 1024).toFixed(1)} KB（主包上限 2048 KB）`);
    console.log(`✓ app.json 里 ${appJson.pages.length} 个页面的 js/wxml 产物均已生成`);
  })
  .catch((e) => {
    console.error('✗ 编译失败:', e && (e.message || e));
    process.exit(1);
  });
