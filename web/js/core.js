/* =============================================================
   core.js —— 接口封装 + IP 组件库（辣条尺 / 辣椒尺 / 严选章 / 条总）
   组件 SVG 沿用 latiaomei-pages-v4.html 的 IP 系统，尺寸由 CSS 控制。
   ============================================================= */
window.LTM = (function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const num = (n) => (Number(n) || 0);
  const yen = (n) => (num(n) > 0 ? '¥' + num(n) : '面议');
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  // 五档判定：跟后端 store.TierLabel / public.go tierMetas 保持一致。
  const TIERS = {
    hang: { label: '夯', name: '闭眼冲', en: 'HANG · 闭眼冲', color: '#b58f4a', bg: 'var(--acid)' },
    dingji: { label: '顶级', name: '行业标杆', en: 'DINGJI · 值得排队', color: '#d8b877', bg: '#FFB8D4' },
    renshang: { label: '人上人', name: '有亮点', en: 'RENSHANG · 不踩雷', color: '#8aa06b', bg: '#BDEDC8' },
    npc: { label: 'NPC', name: '平平无奇', en: 'NPC · 路人甲', color: '#8a8478', bg: '#8FE9FF' },
    la: { label: '拉完了', name: '彻底避雷', en: 'LA · 谁去谁哭', color: '#a0503c', bg: '#141414' },
  };
  const tier = (code) => TIERS[code] || TIERS.npc;
  const tierLabel = (code) => tier(code).label;

  // 内容主题：跟后端 store/kind.go 对齐。探店=出去踩店，御膳房=她家灶台。
  const KINDS = {
    tandian: { label: '探店', sub: '踩过才敢判' },
    yushanfang: { label: '御膳房', sub: '她亲手做的' },
  };
  const kind = (code) => KINDS[code] || KINDS.tandian;

  const PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#efe7d8"/>' +
    '<text x="60" y="74" text-anchor="middle" font-size="44" font-weight="900" fill="#c9bfae">辣</text></svg>');
  const img = (src) => esc(src || PLACEHOLDER);

  /* ---------------- 接口 ---------------- */
  async function req(method, path, body, extraHeaders) {
    const opt = { method: method, credentials: 'same-origin', headers: Object.assign({}, extraHeaders) };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opt);
    } catch (e) {
      throw new Error('网络不通，检查一下连接');
    }
    const text = await res.text();
    let d = null;
    try { d = text ? JSON.parse(text) : {}; } catch (e) { throw new Error('服务端返回了看不懂的内容（HTTP ' + res.status + '）'); }
    if (!res.ok || d.ok === false) {
      const err = new Error((d && d.error) || ('请求失败（HTTP ' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return d.data;
  }
  const qs = (q) => {
    const p = new URLSearchParams();
    Object.keys(q || {}).forEach((k) => { if (q[k] !== '' && q[k] != null) p.set(k, q[k]); });
    const s = p.toString();
    return s ? '?' + s : '';
  };
  const api = {
    get: (path, q) => req('GET', path + qs(q)),
    post: (path, body) => req('POST', path, body === undefined ? {} : body),
    put: (path, body) => req('PUT', path, body),
    del: (path) => req('DELETE', path),
  };

  /* ---------------- IP 组件 ---------------- */
  // 辣条尺：5 根辣条，点亮 n 根（好吃程度 0-5）
  function meter(n, off) {
    n = clamp(Math.round(num(n)), 0, 5);
    let s = '';
    for (let i = 0; i < 5; i++) {
      const on = i < n;
      s += '<svg viewBox="0 0 34 12" width="20" height="8"><path d="M3 7 Q9 1 15 7 T27 7 T33 6" stroke="' +
        (on ? '#FF5A1F' : (off || 'rgba(0,0,0,.16)')) + '" stroke-width="6" fill="none" stroke-linecap="round"/></svg>';
    }
    return s;
  }
  // 辣椒尺：3 个辣椒，点亮 n 个（辣度 0-3）
  function spice(n) {
    n = clamp(Math.round(num(n)), 0, 3);
    let s = '';
    for (let i = 0; i < 3; i++) {
      const on = i < n;
      s += '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M13 5 c4 0 6 3 6 6 c0 6 -6 10 -12 10 c-2 0 -3 -1 -3 -2 c0 -1 1 -1 2 -2 c5 -2 7 -6 7 -12 z" fill="' +
        (on ? '#E4002B' : '#d8d5cd') + '" stroke="#111" stroke-width="1.6"/><path d="M13 5 c0 -2 2 -3 3.5 -3" stroke="#2E7D32" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';
    }
    return s;
  }
  // 严选章：环形文字 + 中心「辣」
  let UID = 0;
  const FF = 'font-family="PingFang SC,Microsoft YaHei,sans-serif"';
  function stamp(size) {
    UID++;
    return '<svg viewBox="0 0 120 120" width="' + size + '" height="' + size + '" ' + FF + '>' +
      '<defs><path id="rg' + UID + '" d="M60,60 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0"/></defs>' +
      '<circle cx="60" cy="60" r="56" fill="none" stroke="#E4002B" stroke-width="5"/>' +
      '<circle cx="60" cy="60" r="33" fill="none" stroke="#E4002B" stroke-width="3"/>' +
      '<text font-size="9.5" fill="#E4002B" font-weight="900" letter-spacing="1"><textPath href="#rg' + UID + '">辣条妹严选 · 只恰真的 · 无广 ·</textPath></text>' +
      '<text x="60" y="71" text-anchor="middle" font-size="30" font-weight="900" fill="#E4002B">辣</text></svg>';
  }
  // 条总：5 种表情 + 举旗姿势
  function mascot(o) {
    o = o || {};
    const eyes = o.eyes || 'normal', mouth = o.mouth || 'open', extra = o.extra || 'none';
    const BODY = 'M100 18 C132 18 142 46 133 72 C125 96 141 112 137 142 C133 172 147 192 131 212 C118 228 82 228 69 212 C53 192 67 172 63 142 C59 112 75 96 67 72 C58 46 68 18 100 18 Z';
    let E = '';
    const W = (x) => '<circle cx="' + x + '" cy="80" r="13" fill="#fff" stroke="#1a1a1a" stroke-width="4"/>';
    if (eyes === 'normal') E = W(83) + W(117) + '<circle cx="86" cy="82" r="5.5" fill="#1a1a1a"/><circle cx="114" cy="82" r="5.5" fill="#1a1a1a"/><circle cx="88" cy="79" r="2" fill="#fff"/><circle cx="116" cy="79" r="2" fill="#fff"/>';
    if (eyes === 'heart') {
      const H = (x) => '<path d="M' + x + ' 74 C' + x + ' 66 ' + (x + 12) + ' 66 ' + (x + 12) + ' 74 C' + (x + 12) + ' 66 ' + (x + 24) + ' 66 ' + (x + 24) + ' 74 C' + (x + 24) + ' 82 ' + (x + 12) + ' 90 ' + (x + 12) + ' 90 C' + (x + 12) + ' 90 ' + x + ' 82 ' + x + ' 74 Z" fill="#FF2E63" stroke="#1a1a1a" stroke-width="3"/>';
      E = H(71) + H(105);
    }
    if (eyes === 'angry') E = W(83) + W(117) + '<circle cx="86" cy="82" r="5.5" fill="#1a1a1a"/><circle cx="114" cy="82" r="5.5" fill="#1a1a1a"/><path d="M68 60 L95 70 M132 60 L105 70" stroke="#1a1a1a" stroke-width="5" stroke-linecap="round"/>';
    if (eyes === 'dead') E = '<path d="M74 70 L92 90 M92 70 L74 90 M108 70 L126 90 M126 70 L108 90" stroke="#1a1a1a" stroke-width="5" stroke-linecap="round"/>';
    if (eyes === 'star') {
      const S = (x) => '<path d="M' + x + ' 64 L' + (x + 5) + ' 75 L' + (x + 16) + ' 80 L' + (x + 5) + ' 85 L' + x + ' 96 L' + (x - 5) + ' 85 L' + (x - 16) + ' 80 L' + (x - 5) + ' 75 Z" fill="#FFD100" stroke="#1a1a1a" stroke-width="3"/>';
      E = S(83) + S(117);
    }
    let M = '';
    if (mouth === 'smile') M = '<path d="M84 102 Q100 118 116 102" stroke="#1a1a1a" stroke-width="5" fill="none" stroke-linecap="round"/>';
    if (mouth === 'open') M = '<path d="M82 100 Q100 128 118 100 Z" fill="#7a1010" stroke="#1a1a1a" stroke-width="4"/><ellipse cx="100" cy="112" rx="9" ry="5" fill="#ff6b6b"/>';
    if (mouth === 'grit') M = '<rect x="84" y="100" width="32" height="14" rx="4" fill="#fff" stroke="#1a1a1a" stroke-width="4"/><path d="M92 100 V114 M100 100 V114 M108 100 V114" stroke="#1a1a1a" stroke-width="3"/>';
    if (mouth === 'drool') M = '<path d="M84 102 Q100 118 116 102" stroke="#1a1a1a" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M112 108 q4 11 -1 17 q-7 -5 -3 -15 Z" fill="#7FD8FF" stroke="#1a1a1a" stroke-width="3"/>';
    if (mouth === 'flat') M = '<path d="M86 107 H114" stroke="#1a1a1a" stroke-width="5" stroke-linecap="round"/>';
    const armL = '<path d="M64 132 Q42 126 34 108" stroke="#1a1a1a" stroke-width="15" fill="none" stroke-linecap="round"/><path d="M64 132 Q42 126 34 108" stroke="#FF6A2A" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="33" cy="106" r="9" fill="#FF6A2A" stroke="#1a1a1a" stroke-width="4"/>';
    let X = '<path d="M136 132 Q158 126 166 110" stroke="#1a1a1a" stroke-width="15" fill="none" stroke-linecap="round"/><path d="M136 132 Q158 126 166 110" stroke="#FF6A2A" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="167" cy="108" r="9" fill="#FF6A2A" stroke="#1a1a1a" stroke-width="4"/>';
    if (extra === 'flag') X = '<path d="M136 128 Q152 118 156 102" stroke="#1a1a1a" stroke-width="15" fill="none" stroke-linecap="round"/><path d="M136 128 Q152 118 156 102" stroke="#FF6A2A" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="156" cy="100" r="9" fill="#FF6A2A" stroke="#1a1a1a" stroke-width="4"/><line x1="156" y1="98" x2="156" y2="42" stroke="#1a1a1a" stroke-width="5"/><rect x="156" y="38" width="44" height="28" fill="#FF2E63" stroke="#1a1a1a" stroke-width="4"/><text x="178" y="57" text-anchor="middle" font-size="15" font-weight="900" fill="#fff" ' + FF + '>严选</text>';
    return '<svg viewBox="0 0 200 250" width="100%" height="100%" ' + FF + '>' +
      '<path d="' + BODY + '" fill="#fff" stroke="#fff" stroke-width="16" stroke-linejoin="round"/>' +
      '<rect x="79" y="218" width="15" height="26" rx="7.5" fill="#C63A17" stroke="#1a1a1a" stroke-width="4"/>' +
      '<rect x="106" y="218" width="15" height="26" rx="7.5" fill="#C63A17" stroke="#1a1a1a" stroke-width="4"/>' +
      '<path d="' + BODY + '" fill="#FF6A2A" stroke="#1a1a1a" stroke-width="5"/>' +
      '<path d="M79 32 C71 62 85 92 77 122 C69 152 83 182 77 206" stroke="#D84315" stroke-width="8" opacity=".5" fill="none" stroke-linecap="round"/>' +
      '<circle cx="112" cy="58" r="3" fill="#C63A17"/><circle cx="95" cy="142" r="3" fill="#C63A17"/>' +
      '<g transform="rotate(-5 100 44)"><rect x="60" y="36" width="80" height="15" rx="7.5" fill="#FFE926" stroke="#1a1a1a" stroke-width="4"/><rect x="131" y="31" width="15" height="11" rx="5" fill="#FFE926" stroke="#1a1a1a" stroke-width="4"/></g>' +
      E + '<circle cx="68" cy="98" r="7.5" fill="#FF8FB1" opacity=".85"/><circle cx="132" cy="98" r="7.5" fill="#FF8FB1" opacity=".85"/>' +
      M + armL + X + '</svg>';
  }
  // 判决字方块（小徽章）
  const vc = (code, size) => '<span class="vc t-' + esc(code) + '"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * .56) + 'px"' : '') + '>' + esc(tierLabel(code)) + '</span>';

  /* 转盘：首页「今天吃什么」的选择困难症救星。
     segs=[{label, href, sub, tier}]，3~12 个扇区；扇区文字沿半径排（经典大转盘点），
     停止时 index j 的扇区中心转到底部指针（指针在下方、尖朝上）处。配色循环用 IP 撞色盘。 */
  const WHEEL_PAL = ['#E9FF3D', '#8FE9FF', '#FFB8D4', '#FFD100', '#CFF3FF', '#FFD9E8'];
  function wheel(segs) {
    segs = (segs || []).slice(0, 12);
    const n = segs.length;
    if (n < 3) return '';
    const step = 360 / n;
    const fs = n <= 8 ? 10.5 : (n <= 10 ? 9.5 : 9);
    const maxLen = n <= 8 ? 5 : (n <= 10 ? 4 : 3);
    const dot = (a, r) => [100 + r * Math.sin(a * Math.PI / 180), 100 - r * Math.cos(a * Math.PI / 180)];
    let g = '';
    segs.forEach((s, i) => {
      const a0 = i * step, a1 = (i + 1) * step;
      const p0 = dot(a0, 92), p1 = dot(a1, 92);
      const lb = String(s.label || '');
      // 标签沿扇区中线摆放但字始终正立（汉字转盘不能出现下半圈倒字）；
      // 45° 间隔下正立文字互不重叠，最挤的左右两区也有弧距 > 标签宽。
      const tp = dot(a0 + step / 2, 60);
      g += '<path d="M100 100L' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
        'A92 92 0 0 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
        'Z" fill="' + WHEEL_PAL[i % WHEEL_PAL.length] + '" stroke="#111" stroke-width="2"/>' +
        '<text x="' + tp[0].toFixed(2) + '" y="' + (tp[1] + 4).toFixed(2) + '" text-anchor="middle" font-size="' + fs +
        '" font-weight="900" fill="#111">' +
        esc(lb.length > maxLen ? lb.slice(0, maxLen - 1) + '…' : lb) + '</text>';
    });
    const compact = segs.map((s) => ({ l: String(s.label || ''), h: s.href || '', s: s.sub || '', t: s.tier || '' }));
    return '<div class="wheelbox" data-segs="' + esc(JSON.stringify(compact)) + '">' +
      '<div class="wheel"><div class="wdisc"><svg viewBox="0 0 200 200" ' + FF + '>' + g +
      '<circle cx="100" cy="100" r="94" fill="none" stroke="#111" stroke-width="6"/></svg></div>' +
      '<div class="wptr"></div><button class="whub" type="button" aria-label="转一下">转</button></div>' +
      '<div class="wres"></div></div>';
  }
  // 转盘交互：中心钮点一下转 5~6 圈，4.2s 减速后出结果卡。用页面渲染完的 after 钩子挂。
  function bindWheels(root) {
    (root || document).querySelectorAll('.wheelbox').forEach((el) => {
      let segs = [];
      try { segs = JSON.parse(el.getAttribute('data-segs') || '[]'); } catch (e) { return; }
      if (segs.length < 3) return;
      const disc = el.querySelector('.wdisc'), hub = el.querySelector('.whub'), res = el.querySelector('.wres');
      let cur = 0, timer = null;
      hub.addEventListener('click', () => {
        if (hub.classList.contains('busy')) return;
        hub.classList.add('busy');
        const n = segs.length, step = 360 / n;
        const j = Math.floor(Math.random() * n);
        // 扇区 j 的中心对准底部指针（盘面正下方 = 顶部起算 180°），±35% 扇区内抖一下，别总停正中间
        const jitter = (Math.random() - 0.5) * step * 0.7;
        const target = (((180 - (j * step + step / 2) + jitter) % 360) + 360) % 360;
        cur += (target - (((cur % 360) + 360) % 360) + 360) % 360 + 360 * (5 + Math.floor(Math.random() * 2));
        disc.style.transform = 'rotate(' + cur + 'deg)';
        res.className = 'wres';
        res.innerHTML = '';
        clearTimeout(timer);
        timer = setTimeout(() => {
          hub.classList.remove('busy');
          const s = segs[j], bad = s.t === 'la';
          res.className = 'wres on' + (bad ? ' bad' : '');
          res.innerHTML = vc(s.t || 'npc', 30) +
            '<div class="rw"><b>' + esc(s.l) + '</b>' + (s.s ? '<small>' + esc(s.s) + '</small>' : '') + '</div>' +
            (s.h ? '<a href="' + esc(s.h) + '" data-track>' + (bad ? '偏要恰？' : '就它了 →') + '</a>' : '');
          if (bad) toast('转到雷了 · 这条真的拉，回头还来得及');
        }, 4380);
      });
    });
  }

  /* ---------------- 业务渲染片段 ---------------- */
  // 点评卡：图 + 判决字 + 菜名 + 毒舌一句 + 双尺 + 价格
  function rvCard(r, opts) {
    opts = opts || {};
    const t = tier(r.tier);
    const cover = r.cover || (r.images && r.images[0]) || '';
    return '<a class="rv" href="/review/' + esc(r.slug) + '" data-track>' +
      '<div class="ph"><img src="' + img(cover) + '" alt="' + esc(r.dish) + '" loading="lazy">' + vc(r.tier) + '</div>' +
      '<div>' +
      '<h4>' + esc(r.dish) + '</h4>' +
      '<div class="say nowrap">' + esc(r.headline || t.name) + '</div>' +
      (r.kind === 'yushanfang' && !opts.noKind
        ? '<div class="shopline rec">🍳 ' + kind(r.kind).label + ' · ' + kind(r.kind).sub + '</div>'
        : (r.shop && !opts.noShop ? '<div class="shopline">' + esc(r.shop.name) + ' · ' + esc(r.shop.city) + esc(r.shop.district) + '</div>' : '')) +
      '<div class="mrow">' +
      '<span class="g">好吃 ' + meter(r.score) + '</span>' +
      '<span class="g">' + spice(r.spicy) + '</span>' +
      (r.revisit > 0 ? '<span class="g">回头 ' + num(r.revisit) + ' 次</span>' : '') +
      '</div></div>' +
      '<span class="pr">' + yen(r.price) + '</span></a>';
  }
  // 排行行：名次贴纸 + 图 + 菜名 + 店名 + 辣条尺 + 判决字
  function rkRow(r, no) {
    return '<a class="rkrow" href="/review/' + esc(r.slug) + '" data-track>' +
      '<div class="no">' + (no || r.rank_no || '·') + '</div>' +
      '<img src="' + img(r.cover) + '" alt="' + esc(r.dish) + '" loading="lazy">' +
      '<div><div class="dn nowrap">' + esc(r.dish) + '</div>' +
      '<div class="shp nowrap">' + esc(r.shop ? r.shop.name : '') + '</div>' +
      '<div class="mtr">' + meter(r.score) + (num(r.view_count) > 0 ? '<small>浏览 ' + num(r.view_count) + '</small>' : '') + '</div></div>' +
      vc(r.tier) + '</a>';
  }
  // 领奖台（前三名）
  function podium(items) {
    if (!items || items.length < 3) return '';
    const cell = (r, place, cls) => '<div class="p p' + place + '"><div class="blk">' +
      (place === 1 ? '<div class="masc">' + mascot({ extra: 'flag' }) + '</div><div class="stmp">' + stamp(32) + '</div>' : '') +
      '<div class="rk">' + place + '</div>' +
      '<img src="' + img(r.cover) + '" alt="' + esc(r.dish) + '" loading="lazy">' +
      '<div class="nm nowrap">' + esc(r.dish) + '</div>' +
      '<div class="mtr">' + meter(r.score) + '</div></div>' +
      '<a class="tap" href="/review/' + esc(r.slug) + '" data-track style="position:absolute;inset:0" aria-label="' + esc(r.dish) + '"></a></div>';
    return '<div class="pod">' + cell(items[1], 2) + cell(items[0], 1) + cell(items[2], 3) + '</div>';
  }
  // 弹幕墙
  function wall(lines) {
    if (!lines || !lines.length) return '';
    return '<div class="wall3"><h6>弹幕墙 · 都是吃过的人</h6>' +
      lines.map((l) => '<p><b>' + esc(l.who) + '：</b>' + esc(l.text) + '</p>').join('') + '</div>';
  }
  const empty = (title, sub) => '<div class="empty"><div class="m">' + mascot({ eyes: 'drool', mouth: 'flat' }) + '</div><h5>' + esc(title) + '</h5><p>' + esc(sub || '') + '</p></div>';
  const loading = (text) => '<div class="loadmore"><span class="spin"></span>' + esc(text || '条总还在吃…') + '</div>';
  const skelList = (n) => '<div class="list">' + new Array(n || 3).fill('<div class="skel" style="height:106px"></div>').join('') + '</div>';

  /* ---------------- 站点引导数据 ---------------- */
  let bootCache = null;
  async function boot(force) {
    if (bootCache && !force) return bootCache;
    bootCache = await api.get('/api/bootstrap');
    return bootCache;
  }
  const site = (key, def) => {
    if (bootCache && bootCache.site && bootCache.site[key] != null && bootCache.site[key] !== '') return bootCache.site[key];
    return def == null ? '' : def;
  };

  /* ---------------- 交互小件 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2000);
  }
  const track = (p) => { try { api.post('/api/track', { p: p }).catch(() => {}); } catch (e) { /* 埋点失败不影响浏览 */ } };

  const fmtDate = (unix) => {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  return {
    esc, num, yen, clamp, tier, tierLabel, TIERS, kind, KINDS, img, PLACEHOLDER,
    meter, spice, stamp, mascot, vc, wheel, bindWheels, rvCard, rkRow, podium, wall, empty, loading, skelList,
    api, boot, site, toast, track, fmtDate,
  };
})();
