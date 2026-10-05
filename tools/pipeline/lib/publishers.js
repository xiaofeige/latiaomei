'use strict';
// publishers.json 读取层：社媒四平台（douyin/xiaohongshu/zhihu/weibo）的发布配置。
// 带 mtime 缓存——辣条妹改配置不用重启 worker。
// 约定：所有以 "_" 开头的 key 是给人看的注释，代码忽略。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'publishers.json');
const PLATFORMS = ['douyin', 'xiaohongshu', 'zhihu', 'weibo'];

let cache = { mtime: 0, data: null };

function raw() {
  let st;
  try {
    st = fs.statSync(FILE);
  } catch {
    return { browser: {}, defaults: {} }; // 配置文件被删也不炸，全部走"发布包"降级
  }
  if (!cache.data || cache.data.__mtime !== st.mtimeMs) {
    try {
      cache.data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache.data.__mtime = st.mtimeMs;
    } catch (e) {
      throw new Error(`publishers.json 解析失败（先别改文案，修好 JSON 再重试）：${e.message}`);
    }
  }
  return cache.data;
}

const isTodo = (v) => !v || /^TODO/i.test(String(v));

// platform(name) → 合并过 defaults 的平台配置；未定义返回 null。
function platform(name) {
  const c = raw();
  const p = c[name];
  if (!p || typeof p !== 'object') return null;
  return { ...c.defaults, ...p, _browser: c.browser || {}, _name: name };
}

// 能走浏览器自动发布的判断：enabled 且 cookie 非 TODO 且 chrome 存在。
// 返回 { ok, why }，why 用人话，直接写进任务 note。
function readiness(name) {
  const p = platform(name);
  if (!p) return { ok: false, why: `publishers.json 缺 ${name} 段` };
  if (!p.enabled) return { ok: false, why: `${p.label}未启用（publishers.json: enabled=false）` };
  if (isTodo(p.cookie)) return { ok: false, why: `${p.label} cookie 未填（TODO）` };
  const chrome = p._browser.chrome_path;
  if (!chrome || !fs.existsSync(chrome)) return { ok: false, why: `${p.label} 找不到浏览器（browser.chrome_path）` };
  return { ok: true, p };
}

// worker 启动提醒：哪些平台还没配好，直接打印在日志里。
function reminders() {
  return PLATFORMS.map((n) => {
    const r = readiness(n);
    return r.ok ? null : `${n}: ${r.why}`;
  }).filter(Boolean);
}

// cookie 整串 → puppeteer.setCookie 需要的数组。
function parseCookie(cookieStr, domain) {
  return String(cookieStr)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain, path: '/' };
    })
    .filter((c) => c.name);
}

module.exports = { FILE, PLATFORMS, raw, platform, readiness, reminders, isTodo, parseCookie };
