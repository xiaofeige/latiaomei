'use strict';
// 主动素材搜集：文案/分镜里给出的检索词 → 联网搜图/搜视频 → 下载校验 → 落进渲染项目 assets/。
// 设计动机：成片不能只有文字卡。用户上传的图不一定可用，所以每条分镜都应"自己去找画面"。
// 检索走 Bing 图片/视频 async 接口（无需 key、国内可达、返回 murl 直链）。
// 铁律：只搜集、只剪辑进视频，不做发布；下载失败/校验不过就降级为文字卡，绝不卡死流水线。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 全屏竖屏背景对糊图零容忍：短边低于这个像素直接弃用（v12：以前 15KB 的缩略图也敢放大铺满）。
const IMG_MIN_SIDE = Number(process.env.IMG_MIN_SIDE || 540);
function minSide(file) {
  try {
    const out = cp.execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file], { encoding: 'utf8' }).trim();
    const [w, h] = out.split('x').map(Number);
    return Math.min(w || 0, h || 0);
  } catch { return 9999; } // 探测失败不拦，宁放过不卡流水线
}

// 图片魔数白名单（防止直链返回 html/404 页当图片存进去）。
function sniffImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';                       // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';                       // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';                       // GIF
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';                       // BMP
  return false;
}

// 视频魔数（mp4/mov 的 ftyp box、matroska/webm EBML 头）。
function sniffVideo(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return false;
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// 水印图库黑名单：这些站的直链常带大面积水印，剪进成片没法看（冒烟实测 699pic 中招）。
const WATERMARK_HOSTS = ['699pic.com', 'qiantu.com', 'tuju.cc', '588ku.com', 'baotu.com', 'nipic.com', 'huitu.com', 'laotujie.com', 'soomeeie.com'];
function isWatermarked(u) {
  try {
    const h = new URL(u).hostname;
    return WATERMARK_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch { return true; }
}

// 从 Bing 结果 HTML 里抽 murl（原图直链）；图片、视频封面/片段共用这套结构。
function extractMurls(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/murl&quot;:&quot;(.*?)&quot;/g)) {
    const u = decodeHtml(m[1]);
    if (/^https?:\/\//.test(u) && !seen.has(u) && !isWatermarked(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

async function bingAsync(endpoint, query, count) {
  const q = encodeURIComponent(query);
  const url = `https://www.bing.com/${endpoint}/async?q=${q}&first=0&count=${count}&mmasync=1&relp=${count}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://www.bing.com/' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`bing ${endpoint} HTTP ${res.status}`);
  return extractMurls(await res.text());
}

// 搜图片直链（返回一组候选 URL，未下载）。
async function searchImageUrls(query, count = 12) {
  return bingAsync('images', query, count);
}

// 搜视频直链。2026-09 实测 Bing videos/async 已下线（返回 404/HTML），
// 默认短路直接给空集，省掉每镜 4 次无效请求；接口恢复后置 BING_VIDEOS=1 再开。
async function searchVideoUrls(query, count = 12) {
  if (process.env.BING_VIDEOS !== '1') return [];
  return bingAsync('videos', query, count);
}

// 下载并校验单个 URL，成功返回 { kind:'jpg'|'png'|'mp4'..., name }，失败返回 null。
// maxSizeMb 控制图片(默认 20M)/视频(默认 30M)上限，避免拉巨无霸拖垮渲染。
async function download(dir, url, baseName, { kind = 'image', timeoutMs = 30_000 } = {}) {
  const capMb = kind === 'video' ? 30 : 20;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bing.com/' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const isImg = kind !== 'video' && sniffImage(buf);
    const isVid = kind === 'video' && sniffVideo(buf);
    if (!isImg && !isVid) return null;
    if (buf.length < (kind === 'video' ? 50 * 1024 : 15 * 1024)) return null; // 太小=缩略图/破图
    if (buf.length > capMb * 1024 * 1024) return null;
    const ext = (isImg || isVid) === isVid ? isVid : isImg;
    const name = `${baseName}.${ext}`;
    // 关键：assets/ 子目录必须自己保证存在——以前只有 writeProject 建，而下载发生在它之前，
    // 导致 writeFileSync 每次 ENOENT 被静默吞掉 → 全片黑底文字卡（v11 根因修复）。
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', name), buf);
    if (isImg && minSide(path.join(dir, 'assets', name)) < IMG_MIN_SIDE) {
      fs.rmSync(path.join(dir, 'assets', name), { force: true });
      return null; // 太小分辨率不够，换下一个候选
    }
    return { name, kind: isVid ? 'video' : 'image' };
  } catch { return null; }
}

// 给定检索词，搜并下载一张能用的图片；tries 控制最多试几个候选。
// opts.verify：异步审图函数 (absPath, query) => true/false/null（v12 “先理解再插入”），false 则换下一张，null（模型不可用）不拦。
async function fetchImageByQuery(dir, query, baseName, { tries = 5, verify = null } = {}) {
  let urls = [];
  try { urls = await searchImageUrls(query, tries * 3); } catch { return null; }
  for (const u of urls.slice(0, tries)) {
    const got = await download(dir, u, baseName, { kind: 'image' });
    if (!got) continue;
    if (verify) {
      const ok = await verify(path.join(dir, 'assets', got.name), query);
      if (ok === false) {
        fs.rmSync(path.join(dir, 'assets', got.name), { force: true });
        continue; // 图文不符，弃用
      }
    }
    return got.name;
  }
  return null;
}

// 给定检索词，搜并下载一段能用的短视频；失败返回 null。
async function fetchVideoByQuery(dir, query, baseName, { tries = 4 } = {}) {
  let urls = [];
  try { urls = await searchVideoUrls(query, tries * 3); } catch { return null; }
  for (const u of urls.slice(0, tries)) {
    const got = await download(dir, u, baseName, { kind: 'video', timeoutMs: 60_000 });
    if (got) return got.name;
  }
  return null;
}

// 场景里“已有素材”的判定：必须是下载成功落盘的文件名（a0.jpg/s3.png/v1.mp4/cover.jpg...）。
// 历史坑（v11 修复）：LLM 会把 img 填成字符串 "0"，truthy 导致整片跳过搜图 → 全片黑底文字卡。
const ASSET_NAME = /^(a\d+|s\d+|v\d+|cover)\.[a-z0-9]+$/;
function hasAssetName(v) { return typeof v === 'string' && ASSET_NAME.test(v); }

// 给一组分镜就地“找画面”：逐镜用 scene.search 检索→下载，写回 sc.img（文件名）与 sc.video（布尔）。
// 单并发、逐镜试错，避免打爆 1.6G 共享机与触发 Bing 频控。找不到的场景保留文字卡兜底。
// opts: { allowVideo, max, verify } allowVideo=是否允许把部分场景剪成视频片段；max=最多搜集几个场景（省配额）；
// verify=审图函数（见 fetchImageByQuery），没配视觉模型时传 null 即维持旧行为。
// 返回 { need, got } 统计，供 job 打日志/判断是否重跑。
async function sourceScenes(dir, scenes, { allowVideo = true, max = 12, verify = null } = {}) {
  let budget = max, need = 0, got = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    if (hasAssetName(sc.img)) continue; // 真正的素材文件名才算已有画面
    if (sc.img !== undefined) sc.img = ''; // 归一化：LLM 给的 0/"0"/null 等杂值一律清掉
    // video 字段同理归一化成布尔（LLM 可能给 "true"/"是"）。
    sc.video = sc.video === true || String(sc.video).toLowerCase() === 'true';
    const queries = [String(sc.search || '').trim(), String(sc.title || '').trim()].filter(Boolean);
    if (!queries.length || budget <= 0) continue;
    budget--; // 每个待搜场景扣一次配额
    need++;
    // CTA/首屏以外的普通场景，偶数镜可尝试用视频片段增加“剪辑感”；失败自动降级图。
    if (allowVideo && sc.video) {
      for (const q of queries) {
        const v = await fetchVideoByQuery(dir, q, `v${i}`);
        if (v) { sc.img = v; sc.video = true; got++; break; }
      }
      if (sc.img) continue;
    }
    for (const q of queries) {
      const img = await fetchImageByQuery(dir, q, `s${i}`, { verify });
      if (img) { sc.img = img; sc.video = false; got++; break; }
    }
  }
  return { scenes, need, got };
}

module.exports = {
  searchImageUrls, searchVideoUrls, download,
  fetchImageByQuery, fetchVideoByQuery, sourceScenes, hasAssetName,
  sniffImage, sniffVideo,
};
