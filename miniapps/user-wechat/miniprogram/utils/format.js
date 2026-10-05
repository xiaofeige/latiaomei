// 展示格式化：绝对图片 URL、档位徽章色、辣椒、时间。
const config = require('../config');

function absUrl(u) {
  if (!u) return '';
  return u.startsWith('http') ? u : config.ASSET_BASE + (u.startsWith('/') ? '' : '/') + u;
}

// tiers 元数据由 bootstrap/taxonomy 下发；找不到兜底灰色
function tierOf(tiers, code) {
  return (tiers || []).find((t) => t.code === code) || { label: code, name: '', color: '#8a8478' };
}

function score1(v) {
  const n = Number(v) || 0;
  return n.toFixed(1);
}

function priceText(p) {
  return p > 0 ? `人均 ¥${p}` : '价格未标';
}

function spicyText(n) {
  return n > 0 ? '🌶'.repeat(Math.min(3, n)) : '';
}

module.exports = { absUrl, tierOf, score1, priceText, spicyText };
