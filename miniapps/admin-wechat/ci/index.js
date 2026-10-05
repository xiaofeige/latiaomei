/* eslint-disable no-console */
// 用 miniprogram-ci 预览 / 上传「辣条妹管理后台」小程序。
// 用法：
//   node ci/index.js preview --v 1.0.0 -d "联调"        # 生成预览二维码 qr-<appid>.png
//   node ci/index.js upload  --v 1.0.0 -d "初版后台"    # 上传到微信后台"版本管理"
//
// 前置（一次性，需在微信公众平台做）：
//   1) 开发管理 → 开发设置 → 小程序代码上传：下载 private.<appid>.key 放本目录上级（admin-wechat/）
//   2) 同页可"关闭 IP 白名单"或把本机公网 IP 加入白名单，否则上传会被拒
//   3) 服务器域名里加 https://latiaomei.infinityfly.xin（request / uploadFile / downloadFile）
const path = require('path');
const fs = require('fs');
const ci = require('miniprogram-ci');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram');

function readAppid() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
  return cfg.appid;
}

function pickKey(appid) {
  const exact = path.join(ROOT, `private.${appid}.key`);
  if (fs.existsSync(exact)) return exact;
  // 兼容只放了一个 key 文件的情况。
  const any = fs.readdirSync(ROOT).filter((f) => /^private\..+\.key$/.test(f))[0];
  if (any) return path.join(ROOT, any);
  console.error(`\n找不到上传密钥。请把 private.${appid}.key 放到：\n  ${ROOT}\n（微信公众平台 → 开发设置 → 小程序代码上传 里下载）\n`);
  process.exit(1);
}

// 把 --v 的版本号同步进包内常量（miniprogram/config.js 的 APP_VERSION）。
// 「我的→运维」的小程序版本在体验/开发版靠这个常量兑底，不同步就会显示旧版本。
function syncAppVersion(version) {
  const p = path.join(PROJ, 'config.js');
  const s = fs.readFileSync(p, 'utf8');
  if (!/APP_VERSION:\s*'[^']*'/.test(s)) {
    console.error('\nminiprogram/config.js 里缺 APP_VERSION 常量，先手动加一行 APP_VERSION: \'0.0.0\'。\n');
    process.exit(1);
  }
  fs.writeFileSync(p, s.replace(/APP_VERSION:\s*'[^']*'/, `APP_VERSION: '${version}'`));
  console.log(`  已同步包内版本常量：APP_VERSION = ${version}`);
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { cmd: a[0], version: '1.0.0', desc: '', robot: 1 };
  for (let i = 1; i < a.length; i++) {
    const k = a[i];
    if ((k === '--v' || k === '--version') && a[i + 1]) { out.version = a[++i]; }
    else if ((k === '-d' || k === '--desc') && a[i + 1]) { out.desc = a[++i]; }
    else if (k === '--r' && a[i + 1]) { out.robot = Number(a[++i]); }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const appid = readAppid();
  if (!appid || appid === 'touristappid') {
    console.error('\nproject.config.json 里的 appid 还是占位值 touristappid，先填上真实小程序 AppID。\n');
    process.exit(1);
  }
  if (args.cmd === 'upload' || args.cmd === 'preview') syncAppVersion(args.version);

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: PROJ,
    privateKeyPath: pickKey(appid),
    ignores: ['node_modules/**/*'],
  });

  if (args.cmd === 'preview') {
    const info = await ci.preview({
      project,
      version: args.version,
      desc: args.desc || '预览',
      robot: args.robot,
      qrcodeFormat: 'image',
      qrcodeOutputDest: path.join(ROOT, `qr-${appid}.png`),
      onProgress: (t) => console.log('  编译：', t),
    });
    console.log(`\n预览二维码已生成：${info.qrcodeDest || path.join(ROOT, `qr-${appid}.png`)}`);
    console.log('用微信"扫一扫"即可在真机上打开（需你是项目成员/体验成员）。\n');
    return;
  }

  if (args.cmd === 'upload') {
    await ci.upload({
      project,
      version: args.version,
      desc: args.desc || 'CI 上传',
      robot: args.robot,
      onProgress: (t) => console.log('  编译：', t),
      // 代码包体积对 2MB 主包敏感，关掉 sourcemap 上传可减小产物。
      sceneBits: undefined,
    });
    console.log(`\n上传成功：v${args.version}（${args.desc || 'CI 上传'}）`);
    console.log('下一步：微信公众平台 → 版本管理 → 设为体验版 或 提交审核。\n');
    return;
  }

  console.error('\n未知命令。用：node ci/index.js <preview|upload> --v 1.0.0 -d "说明"\n');
  process.exit(1);
}

main().catch((e) => {
  console.error('\n失败：', e && (e.message || e), '\n');
  console.error('常见原因：密钥不匹配 / 本机 IP 不在白名单 / appid 填错 / 源码语法有错。\n');
  process.exit(1);
});
