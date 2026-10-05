// 展示层小工具：把后端字段翻译成适合界面显示的字符串。
const config = require('../config');

// 五档判定 → 徽章配色（与服务端 tierMetas 对齐）：夯 > 顶级 > 人上人 > NPC > 拉完了。
const TIERS = {
  hang: { label: '夯', color: '#b58f4a', desc: '闭眼冲' },
  dingji: { label: '顶级', color: '#d8b877', desc: '行业标杆' },
  renshang: { label: '人上人', color: '#8aa06b', desc: '有亮点' },
  npc: { label: 'NPC', color: '#8a8478', desc: '平平无奇' },
  la: { label: '拉完了', color: '#a0503c', desc: '彻底避雷' },
};

module.exports = {
  TIERS,
  tier(code) {
    return TIERS[code] || { label: code || '-', color: '#999', desc: '' };
  },

  // 相对时间：列表里显示"3 天前"比时间戳友好。
  ago(unixSec) {
    if (!unixSec) return '';
    const d = Date.now() / 1000 - unixSec;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    return this.date(unixSec);
  },

  date(unixSec) {
    if (!unixSec) return '';
    const t = new Date(unixSec * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  },

  // 图片补全成绝对地址；已是 http(s) 直接返回。
  fullUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//.test(path)) return path;
    const base = config.ASSET_BASE || config.API_BASE;
    return base + (path[0] === '/' ? path : '/' + path);
  },

  bytes(n) {
    if (!n && n !== 0) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + u[i];
  },

  num(n) {
    n = n || 0;
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    return '' + n;
  },
};
