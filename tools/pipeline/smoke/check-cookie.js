'use strict';
// 登录态体检：只干一件事——用 publishers.json 里粘的 cookie 打开对应平台的创作端，
// 看是否认得你的登录，并截一张图给你在服务器上看证据。**绝不点发布**。
//
//   node tools/pipeline/smoke/check-cookie.js                 # 四平台全查（只查配置，不起浏览器）
//   node tools/pipeline/smoke/check-cookie.js xiaohongshu     # 起浏览器真查登录态并截屏
//   node tools/pipeline/smoke/check-cookie.js --all           # 四平台起浏览器真查
//
// 退出码：0=全部 ok；1=有平台 cookie 没填/未启用；2=有平台 cookie 失效（登录态没拿到）。
const fs = require('fs');
const path = require('path');
const { CFG } = require('../lib/env');
const pub = require('../lib/publishers');

const PLATFORMS = pub.PLATFORMS;
const stamp = () => new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
// 对外域名：从服务端 env 里读 LATIAOMEI_DOMAIN，读不到就退回本地回环。
function publicBase() {
  try {
    const s = fs.readFileSync('/data/www/latiaomei/deploy/latiaomei.env', 'utf8');
    const m = s.match(/^LATIAOMEI_DOMAIN=\s*"?([^"\n]+)/m);
    if (m) return 'https://' + m[1].trim();
  } catch { /* 没权限读就降级回本地 */ }
  return CFG.apiBase;
}

function configOnly(name) {
  const p = pub.platform(name);
  const r = pub.readiness(name);
  console.log(`\n[${name}] ${p.label}`);
  console.log(`  enabled      : ${p.enabled}`);
  console.log(`  auto_publish : ${p.auto_publish}（false=只预填不点发布）`);
  console.log(`  media        : ${p.media}`);
  console.log(`  cookie       : ${pub.isTodo(p.cookie) ? '❌ 还是 TODO，没填' : `✅ 已填 ${String(p.cookie).length} 字符（不回显内容）`}`);
  console.log(`  判定         : ${r.ok ? '✅ 可自动发布' : '⏸ ' + r.why}`);
  return r.ok;
}

async function realCheck(name) {
  const p = pub.platform(name);
  const puppeteer = require('puppeteer-core');
  const logDir = path.join(CFG.uploadsDir, 'social', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const shot = path.join(logDir, `cookie-check-${name}-${stamp()}.png`);
  const b = p._browser;
  const browser = await puppeteer.launch({
    executablePath: b.chrome_path,
    headless: b.headless !== false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
  });
  try {
    const page = await browser.newPage();
    await page.setDefaultTimeout(b.nav_timeout_ms || 60000);
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie(...pub.parseCookie(p.cookie, p.cookie_domain));
    await page.goto(p.url, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 5000)); // 创作端是 SPA，等框架挂载
    await page.screenshot({ path: shot });
    const found = await page.$(p.login_check || 'input[type=file]');
    console.log(`  真查         : ${found ? '✅ 登录态有效（找到编辑区 ' + p.login_check + '）' : '❌ 未认得登录（多半 cookie 过期/域名不对）'}`);
    console.log(`  当前 URL     : ${page.url()}`);
    // /uploads 是公开静态目录（无登录），所以文件名带随机串，隺不到别人的地址。
    const relUploads = path.relative(CFG.uploadsDir, shot).split(path.sep).join('/');
    console.log(`  截屏落盘     : ${shot}`);
    console.log(`  手机上看      : ${publicBase()}/uploads/${relUploads}`);
    return !!found;
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const picks = args.filter((a) => !a.startsWith('--'));
  const targets = all || !picks.length ? PLATFORMS : picks;
  for (const t of targets) if (!PLATFORMS.includes(t)) { console.error(`未知平台 ${t}，可选：${PLATFORMS.join(' / ')}`); process.exit(3); }

  let cfgOk = 0, loginOk = 0, real = 0;
  for (const t of targets) {
    if (configOnly(t)) cfgOk++;
    // 只有"配置齐 + 明确要真查"才起浏览器（--all 或平台名单里点名了它）
    if (all || picks.includes(t)) {
      if (pub.readiness(t).ok) { real++; loginOk += (await realCheck(t)) ? 1 : 0; }
      else console.log('  真查         : 跳过（配置不齐，起了也没意义）');
    }
  }
  console.log(`\n小结：配置就绪 ${cfgOk}/${targets.length}` + (real ? `；登录态有效 ${loginOk}/${real}` : ''));
  console.log('改 publishers.json 不用重启 worker（按 mtime 热加载）。填 cookie 的正确姿势见该文件顶部「必读」。');
  process.exit(cfgOk === targets.length && (!real || loginOk === real) ? 0 : (real && loginOk < real ? 2 : 1));
})();
