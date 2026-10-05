/* =============================================================
   admin.js —— 后台。hash 路由：#/overview #/reviews #/shops #/tastes
   #/settings #/uploads #/maint。所有写操作都会带上 CSRF 头。
   ============================================================= */
(function () {
  'use strict';
  const L = window.LTM;
  const esc = L.esc, num = L.num, yen = L.yen;
  const root = document.getElementById('root');

  let csrf = '';
  let me = '';

  /* ---------------- 请求层 ---------------- */
  async function req(method, path, body, isForm) {
    const headers = {};
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const opt = { method: method, credentials: 'same-origin', headers: headers };
    if (isForm) {
      opt.body = body; // FormData：Content-Type 交给浏览器
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(path, opt);
    const txt = await res.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : {}; } catch (e) { throw new Error('服务端返回了看不懂的内容（HTTP ' + res.status + '）'); }
    if (!res.ok || d.ok === false) {
      const err = new Error((d && d.error) || ('请求失败（HTTP ' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return d.data;
  }
  const api = {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
    form: (p, fd) => req('POST', p, fd, true),
  };

  /* ---------------- 小工具 ---------------- */
  function bsize(n) {
    n = num(n);
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function stamp(unix) {
    if (!unix) return '—';
    const d = new Date(unix * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const load = (text) => '<div class="loadmore"><span class="spin"></span>' + esc(text || '读数据…') + '</div>';
  const errBox = (e) => '<div class="box"><b style="color:var(--red)">出错了：' + esc(e.message || e) + '</b></div>';
  const inp = (label, name, val, attrs) =>
    '<label>' + esc(label) + '<input name="' + name + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '></label>';
  const ta = (label, name, val, rows) =>
    '<label>' + esc(label) + '<textarea name="' + name + '"' + (rows ? ' rows="' + rows + '"' : '') + '>' + esc(val == null ? '' : val) + '</textarea></label>';
  const sel = (label, name, val, opts) =>
    '<label>' + esc(label) + '<select name="' + name + '">' +
    opts.map((o) => '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></label>';
  const TIER_OPTS = [['hang', '夯 · 闭眼冲'], ['dingji', '顶级 · 行业标杆'], ['renshang', '人上人 · 有亮点'], ['npc', 'NPC · 平平无奇'], ['la', '拉完了 · 彻底避雷']];

  function bars(rows, valueKey, nameKey) {
    const list = rows || [];
    if (!list.length || list.every((x) => !num(x[valueKey]))) {
      return '<div class="hint">这个区间还没有访问数据（探针、机器人不算 PV）。</div>';
    }
    const max = Math.max(1, ...list.map((x) => num(x[valueKey])));
    return '<div class="bars">' + list.map((x) => {
      const v = num(x[valueKey]);
      const h = v > 0 ? Math.max(4, Math.round(v / max * 100)) : 2;
      return '<div style="height:' + h + '%" title="' + esc(x[nameKey] || '') + ':' + v + '">' +
        (v > 0 ? '<span>' + v + '</span>' : '') + '</div>';
    }).join('') + '</div>' +
      '<div class="hint">' + esc(list.length ? (list[0][nameKey] + ' → ' + list[list.length - 1][nameKey]) : '') + '</div>';
  }
  function rankList(items, emptyText) {
    if (!items || !items.length) return '<div class="hint">' + esc(emptyText || '暂无数据') + '</div>';
    const max = Math.max(1, ...items.map((x) => num(x.value)));
    return '<div class="rank">' + items.map((x) =>
      '<div><span class="bar" style="width:' + Math.max(6, Math.round(num(x.value) / max * 60)) + 'px"></span>' +
      '<b>' + esc(x.name) + '</b><small>' + num(x.value) + '</small></div>').join('') + '</div>';
  }

  /* ---------------- 登录 ---------------- */
  function loginView(msg) {
    root.innerHTML = '<div class="login-wrap"><div class="box">' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:12px">' +
      '<div style="width:36px">' + L.mascot({ mouth: 'flat' }) + '</div>' +
      '<div><b style="font-size:16px">辣条妹 · 后台</b><div class="hint" style="margin:0">自己人进，别乱点</div></div></div>' +
      '<form class="adm-form" id="loginform" autocomplete="on">' +
      inp('账号', 'username', '', 'autocomplete="username" required') +
      inp('密码', 'password', '', 'type="password" autocomplete="current-password" required') +
      '<div class="btnrow"><button class="btn p" type="submit">进去干活</button><a class="btn" href="/">回前台</a></div>' +
      '<div class="err" id="loginerr">' + esc(msg || '') + '</div></form></div></div>';
    document.getElementById('loginform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      document.getElementById('loginerr').textContent = '';
      try {
        const d = await api.post('/api/admin/login', {
          username: f.elements.username.value.trim(),
          password: f.elements.password.value,
        });
        csrf = d.csrf;
        me = d.username;
        if (!location.hash) location.hash = '#/overview';
        render();
      } catch (err) {
        document.getElementById('loginerr').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  /* ---------------- 骨架 ---------------- */
  const NAV = [['overview', '概览'], ['reviews', '点评'], ['shops', '店铺'], ['tastes', '标签'],
    ['settings', '站点配置'], ['uploads', '图库'], ['maint', '维护']];
  function shell(active, body) {
    root.innerHTML = '<div class="adm-top"><div class="mt">' + L.mascot({ mouth: 'open' }) + '</div>' +
      '<div><b>辣条妹 · 后台</b><small>LATIAOMEI ADMIN</small></div>' +
      '<div class="sp"><span class="hint hide-sm" style="margin:0">' + esc(me) + '</span>' +
      '<a class="btn sm" href="/" target="_blank" rel="noopener">看前台</a>' +
      '<button class="btn sm d" id="logout" type="button">退出</button></div></div>' +
      '<div class="adm"><div class="adm-nav">' + NAV.map((n) =>
        '<button type="button" data-nav="' + n[0] + '" class="' + (n[0] === active ? 'on' : '') + '">' + n[1] + '</button>').join('') +
      '</div><div class="panel" id="panel">' + body + '</div></div>';
    root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.getAttribute('data-nav'); }));
    document.getElementById('logout').addEventListener('click', async () => {
      try { await api.post('/api/admin/logout'); } catch (e) { /* 退出失败也要回登录页 */ }
      csrf = ''; me = '';
      L.toast('已退出');
      loginView('');
    });
  }

  /* ---------------- 概览 ---------------- */
  async function vOverview() {
    shell('overview', load('正在读访问数据…'));
    let d;
    try { d = await api.get('/api/admin/overview?days=14'); } catch (e) { document.getElementById('panel').innerHTML = errBox(e); return; }
    const t = d.today || {}, y = d.yesterday || {}, c = d.content || {}, s = d.storage || {}, r = d.runtime || {};
    const dv = t.pv - (y.pv || 0);
    const statCard = (label, value, sub) => '<div class="stat"><small>' + esc(label) + '</small><b>' + value + '</b><small>' + esc(sub || '') + '</small></div>';
    let body = '<div class="grid c4">' +
      statCard('今日 PV', num(t.pv), '昨日 ' + num(y.pv)) +
      statCard('今日 UV', num(t.uv), '昨日 ' + num(y.uv)) +
      statCard('较昨日', (dv >= 0 ? '+' : '') + dv, t.pv ? (dv >= 0 ? '在涨' : '掉了') : '还没数据') +
      statCard('今日错误', num(t.err), '机器人 ' + num(t.bot)) + '</div>';

    body += '<div class="grid c2" style="margin-top:11px">' +
      '<div class="box"><h4>近 14 天 PV</h4>' + bars(d.series || [], 'pv', 'date') + '</div>' +
      '<div class="box"><h4>今日 24 小时</h4>' + bars((d.hourly || []).slice(0, 24), 'value', 'name') + '</div>' +
      '</div>';

    body += '<div class="grid c3" style="margin-top:11px">' +
      '<div class="box"><h4>今日热门路径</h4>' + rankList(d.top_paths) + '</div>' +
      '<div class="box"><h4>今日来源</h4>' + rankList(d.top_refs, '今天全是直接访问') + '</div>' +
      '<div class="box"><h4>设备</h4>' + rankList(d.devices) + '</div>' +
      '<div class="box"><h4>被翻牌子的点评</h4>' + rankList(d.top_reviews) + '</div>' +
      '<div class="box"><h4>被翻牌子的店</h4>' + rankList(d.top_shops) + '</div>' +
      '<div class="box"><h4>运行状态</h4>' +
        '<div class="rank"><div><b>Go</b><small>' + esc(String(r.go_version || '').replace('go', '')) + '</small></div>' +
        '<div><b>协程</b><small>' + num(r.goroutines) + '</small></div>' +
        '<div><b>内存</b><small>' + bsize(r.mem_alloc) + ' / ' + bsize(r.mem_sys) + '</small></div>' +
        '<div><b>已运行</b><small>' + Math.round(num(r.uptime_secs) / 60) + ' 分钟</small></div>' +
        '<div><b>未落盘 PV</b><small>' + num((r.collector || {}).pending_pv) + '</small></div>' +
        '<div><b>上次清理</b><small>' + (r.last_prune_at ? stamp(Number(r.last_prune_at)) : '还没跑') + '</small></div></div></div>' +
      '</div>';

    body += '<div class="grid c2" style="margin-top:11px">' +
      '<div class="box"><h4>内容量</h4><div class="grid c2">' +
        statCard('已发布', num(c.published), '草稿 ' + num(c.drafts)) +
        statCard('店铺', num(c.shops), '城市 ' + num(c.cities)) +
        statCard('夯', num(c.hang), '拉 ' + num(c.la)) +
        statCard('累计浏览', num(c.views), '标签 ' + num(c.tastes)) + '</div></div>' +
      '<div class="box"><h4>存储占用</h4><div class="grid c2">' +
        statCard('数据库', bsize(s.db_bytes), 'WAL ' + bsize(s.wal_bytes)) +
        statCard('可回收', bsize(s.freeable_bytes), '跑一次清理') +
        statCard('图片', bsize(s.upload_bytes), num(s.upload_files) + ' 个文件') +
        statCard('合计', bsize(s.total_bytes), s.db_err ? '读库有错' : '健康') + '</div></div></div>';

    body += '<div class="btnrow" style="margin-top:12px">' +
      '<a class="btn" href="/api/admin/export">导出内容 JSON</a>' +
      '<button class="btn" type="button" data-nav="uploads">去图库</button>' +
      '<button class="btn" type="button" data-nav="maint">去维护</button></div>';
    document.getElementById('panel').innerHTML = body;
    document.querySelectorAll('#panel [data-nav]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.getAttribute('data-nav'); }));
  }

  /* ---------------- 点评 ---------------- */
  const rvf = { status: 'all', kind: 'all', tier: '', taste: '', q: '', wheel: '', page: 1 };
  let curReview = null;      // 正在编辑的点评（完整对象）
  let curImages = [];        // 编辑中的图片路径
  let shopOptions = [];      // 店铺下拉

  async function ensureShops() {
    if (shopOptions.length) return shopOptions;
    const d = await api.get('/api/admin/shops?size=200');
    shopOptions = (d.items || []).map((s) => [String(s.id), s.name + '（' + (s.city || '') + (s.district || '') + '）']);
    return shopOptions;
  }

  async function vReviews() {
    shell('reviews', load('正在读点评…'));
    const panel = document.getElementById('panel');
    try {
      const qs = new URLSearchParams({ status: rvf.status, kind: rvf.kind, tier: rvf.tier, taste: rvf.taste, q: rvf.q, page: String(rvf.page), size: '20' });
      if (rvf.wheel) qs.set('wheel', rvf.wheel);
      const [page, tastes] = await Promise.all([api.get('/api/admin/reviews?' + qs), api.get('/api/admin/tastes')]);
      const rows = (page.items || []).map((r) => '<tr>' +
        '<td>' + esc(r.dish) + '<div class="hint" style="margin:0">' + (r.kind === 'yushanfang' ? '🍳 御膳房 · 自家菜谱' : esc(r.shop ? r.shop.name : '未挂店')) + '</div></td>' +
        '<td class="hide-sm">' + (r.kind === 'yushanfang' ? '<span class="pill" style="background:#FFE3D2">御膳房</span>' : '<span class="pill">探店</span>') + '</td>' +
        '<td><span class="pill ' + (r.status === 'published' ? 'ok' : 'no') + '">' + (r.status === 'published' ? '已发布' : '草稿') + '</span></td>' +
        '<td>' + esc(r.tier_label || r.tier) + '</td>' +
        '<td>' + num(r.score) + ' / 辣 ' + num(r.spicy) + '</td>' +
        '<td class="hide-sm">' + (r.rank_no ? '#' + num(r.rank_no) : '—') + (r.featured ? ' ★' : '') + '</td>' +
        '<td class="hide-sm">' + (r.wheel ? '🎡 在盘' : '—') + '</td>' +
        '<td class="hide-sm">' + num(r.view_count) + '</td>' +
        '<td><div class="btnrow">' +
          '<button class="btn sm" type="button" data-edit="' + r.id + '">编辑</button>' +
          '<button class="btn sm" type="button" data-status="' + r.id + '" data-to="' + (r.status === 'published' ? 'draft' : 'published') + '">' + (r.status === 'published' ? '撤回' : '发布') + '</button>' +
          '<button class="btn sm" type="button" data-feat="' + r.id + '">特写</button>' +
          '<button class="btn sm" type="button" data-wheel="' + r.id + '" data-on="' + (r.wheel ? '0' : '1') + '">' + (r.wheel ? '下盘' : '上盘') + '</button>' +
          '<a class="btn sm" href="/review/' + esc(r.slug) + '" target="_blank" rel="noopener">看</a>' +
          '<button class="btn sm d" type="button" data-del="' + r.id + '">删</button>' +
        '</div></td></tr>').join('');

      panel.innerHTML =
        '<div class="box"><h4>筛一筛</h4><div class="btnrow">' +
        '<input id="rvq" placeholder="菜名 / 店名 / 正文" value="' + esc(rvf.q) + '" style="border:2.5px solid var(--line);border-radius:10px;padding:7px 10px;font-weight:700;min-width:180px">' +
        sel('状态', 'rvs', rvf.status, [['all', '全部'], ['published', '已发布'], ['draft', '草稿']]) +
        sel('主题', 'rvk', rvf.kind, [['all', '全部'], ['tandian', '🌶 探店'], ['yushanfang', '🍳 御膳房']]) +
        sel('转盘', 'rvw', rvf.wheel, [['', '不限'], ['1', '🎡 只看上盘的']]) +
        sel('档位', 'rvt', rvf.tier, [['', '全部']].concat(TIER_OPTS)) +
        '<button class="btn" type="button" id="rvgo">筛</button>' +
        '<button class="btn a" type="button" id="rvnew">+ 写一条新的</button>' +
        '</div></div>' +
        '<div class="box" style="margin-top:11px"><h4>共 ' + num(page.total) + ' 条</h4>' +
        '<table class="adm-t"><thead><tr><th>菜</th><th class="hide-sm">主题</th><th>状态</th><th>判定</th><th>分/辣</th><th class="hide-sm">名次</th><th class="hide-sm">转盘</th><th class="hide-sm">浏览</th><th>操作</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="9">一条都没有，点「写一条新的」</td></tr>') + '</tbody></table>' +
        '<div class="pager"><button class="btn sm" type="button" id="rvprev"' + (rvf.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span>第 ' + num(page.page) + ' / ' + Math.max(1, Math.ceil(num(page.total) / 20)) + ' 页</span>' +
        '<button class="btn sm" type="button" id="rvnext"' + (page.has_more ? '' : ' disabled') + '>下一页</button></div></div>' +
        '<div id="rvformwrap" style="margin-top:11px"></div>';

      const go = () => {
        rvf.q = document.getElementById('rvq').value.trim();
        rvf.status = document.getElementById('rvs').value;
        rvf.kind = document.getElementById('rvk').value;
        rvf.wheel = document.getElementById('rvw').value;
        rvf.tier = document.getElementById('rvt').value;
        rvf.page = 1;
        vReviews();
      };
      document.getElementById('rvgo').addEventListener('click', go);
      document.getElementById('rvq').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      document.getElementById('rvnew').addEventListener('click', () => showReviewForm(null, tastes));
      document.getElementById('rvprev').addEventListener('click', () => { rvf.page = Math.max(1, rvf.page - 1); vReviews(); });
      document.getElementById('rvnext').addEventListener('click', () => { rvf.page++; vReviews(); });

      panel.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
        try {
          const full = await api.get('/api/admin/reviews/' + b.getAttribute('data-edit'));
          showReviewForm(full, tastes);
        } catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api.post('/api/admin/reviews/' + b.getAttribute('data-status') + '/status', { status: b.getAttribute('data-to') });
          L.toast(b.getAttribute('data-to') === 'published' ? '已发布' : '已收回草稿');
          vReviews();
        } catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-feat]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post('/api/admin/reviews/' + b.getAttribute('data-feat') + '/featured', {}); L.toast('已设成首页特写'); vReviews(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-wheel]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api.post('/api/admin/reviews/' + b.getAttribute('data-wheel') + '/wheel', { on: b.getAttribute('data-on') === '1' });
          L.toast(b.getAttribute('data-on') === '1' ? '已上转盘' : '已从转盘拿下');
          vReviews();
        } catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删了就没了，确定删这条点评？')) return;
        try { await api.del('/api/admin/reviews/' + b.getAttribute('data-del')); L.toast('删掉了'); vReviews(); }
        catch (e) { L.toast(e.message); }
      }));
    } catch (e) {
      panel.innerHTML = errBox(e);
    }
  }

  function imgsHTML() {
    if (!curImages.length) return '<div class="hint">还没有图。一条点评至少给一张：列表页和详情页都用它。</div>';
    return '<div class="thumbs">' + curImages.map((p, i) =>
      '<div class="t"><img src="' + L.img(p) + '" alt=""><div class="m"><span class="nowrap">' + esc(p.split('/').pop()) + '</span>' +
      '<button class="btn sm d" type="button" data-rmimg="' + i + '">×</button></div></div>').join('') + '</div>';
  }

  async function showReviewForm(r, tastes) {
    curReview = r;
    curImages = r && r.images ? r.images.slice() : [];
    const opts = await ensureShops();
    const tid = (r && r.tastes || []).map((t) => t.slug);
    const wrap = document.getElementById('rvformwrap');
    wrap.innerHTML = '<div class="box"><h4>' + (r ? '编辑点评 #' + num(r.id) : '新建点评') + '</h4>' +
      '<form class="adm-form" id="rvf">' +
      '<div class="row">' +
      inp('菜名 *', 'dish', r ? r.dish : '') +
      sel('内容主题', 'kind', r ? (r.kind || 'tandian') : 'tandian', [['tandian', '🌶 探店（出去吃的）'], ['yushanfang', '🍳 御膳房（自家菜谱）']]) +
      sel('挂在哪家店', 'shop_id', r ? String(r.shop_id || '') : '', [['', '不挂店']].concat(opts)) +
      sel('判决档位', 'tier', r ? r.tier : 'dingji', TIER_OPTS) +
      sel('状态', 'status', r ? r.status : 'draft', [['draft', '草稿'], ['published', '已发布']]) +
      '</div>' +
      '<div class="row">' +
      inp('好吃分 0-5', 'score', r ? r.score : 4, 'type="number" step="0.1" min="0" max="5"') +
      inp('辣度 0-5', 'spicy', r ? r.spicy : 0, 'type="number" min="0" max="5"') +
      inp('价格（元；菜谱=单人份成本）', 'price', r ? r.price : 0, 'type="number" min="0"') +
      inp('回头次数（菜谱=做过次数）', 'revisit', r ? r.revisit : 0, 'type="number" min="0"') +
      '</div>' +
      '<div class="row">' +
      inp('榜单名次（0=不进榜）', 'rank_no', r ? r.rank_no : 0, 'type="number" min="0"') +
      inp('吃的日期（菜谱=做的日期）', 'visit_date', r ? r.visit_date : '') +
      inp('slug（留空自动生成）', 'slug', r ? r.slug : '') +
      '</div>' +
      ta('毒舌一句 *（列表和详情都显示这句）', 'headline', r ? r.headline : '') +
      ta('正文（为什么去 / 踩了什么坑）', 'body', r ? r.body : '', 6) +
      ta('隐藏吃法 · 点单建议（菜谱=避坑贴士）', 'order_tip', r ? r.order_tip : '') +
      '<label>图片（第一张自动当封面）</label>' + '<div id="imgs">' + imgsHTML() + '</div>' +
      '<div class="btnrow"><input type="file" id="upfile" accept="image/*" style="max-width:230px">' +
      '<span class="hint" style="margin:0">单图上限跟着服务配置（默认 6MB），会自动压成展示图 + 缩略图</span></div>' +
      '<label>口味 / 场景标签</label><div class="flt" style="padding:0;flex-wrap:wrap">' +
      (tastes || []).map((t) => '<a href="#" data-taste="' + esc(t.slug) + '" class="' + (tid.indexOf(t.slug) >= 0 ? 'on' : '') + '">' +
        esc(t.name) + '<span style="opacity:.6"> ' + num(t.count) + '</span></a>').join('') + '</div>' +
      '<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="rvwheel"' +
      ((r && r.wheel === false) ? '' : ' checked') + ' style="width:18px;height:18px;accent-color:#b58f4a">进首页转盘（关掉后首页转盘不转这道，内容本身照发）</label>' +
      '<div class="btnrow"><button class="btn p" type="submit">保存</button>' +
      '<button class="btn" type="button" id="rvcancel">取消</button>' +
      '<span class="hint" style="margin:0">保存后前台立刻生效</span></div>' +
      '</form></div>';

    const form = document.getElementById('rvf');
    const bindImgs = () => {
      document.getElementById('imgs').innerHTML = imgsHTML();
      document.querySelectorAll('[data-rmimg]').forEach((b) => b.addEventListener('click', () => {
        curImages.splice(Number(b.getAttribute('data-rmimg')), 1);
        bindImgs();
      }));
    };
    bindImgs();
    document.querySelectorAll('[data-taste]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      a.classList.toggle('on');
    }));
    document.getElementById('rvcancel').addEventListener('click', () => { wrap.innerHTML = ''; });
    document.getElementById('upfile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      L.toast('正在压图上传…');
      try {
        const d = await api.form('/api/admin/upload', fd);
        curImages.push(d.path);
        bindImgs();
        L.toast(d.saved_note || '传好了');
      } catch (err) { L.toast(err.message); }
      e.target.value = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        id: r ? r.id : 0,
        slug: f.elements.slug.value.trim(),
        shop_id: Number(f.elements.shop_id.value || 0),
        dish: f.elements.dish.value.trim(),
        kind: f.elements.kind.value,
        tier: f.elements.tier.value,
        score: Number(f.elements.score.value || 0),
        spicy: Number(f.elements.spicy.value || 0),
        price: Number(f.elements.price.value || 0),
        headline: f.elements.headline.value.trim(),
        body: f.elements.body.value,
        order_tip: f.elements.order_tip.value.trim(),
        revisit: Number(f.elements.revisit.value || 0),
        visit_date: f.elements.visit_date.value.trim(),
        rank_no: Number(f.elements.rank_no.value || 0),
        wheel: document.getElementById('rvwheel').checked,
        status: f.elements.status.value,
        images: curImages,
        cover: curImages[0] || '',
        tastes: Array.from(document.querySelectorAll('[data-taste].on')).map((a) => a.getAttribute('data-taste')),
      };
      if (!body.dish) { L.toast('菜名不能空'); return; }
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        if (r) await api.put('/api/admin/reviews/' + r.id, body);
        else await api.post('/api/admin/reviews', body);
        L.toast('存好了');
        vReviews();
      } catch (err) {
        L.toast(err.message);
        btn.disabled = false;
      }
    });
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- 店铺 ---------------- */
  let curShop = null;
  async function vShops() {
    shell('shops', load('正在读店铺…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/shops?size=200&q=' + encodeURIComponent(rvf.q || ''));
      panel.innerHTML = '<div class="box"><h4>共 ' + num(d.total) + ' 家店</h4>' +
        '<table class="adm-t"><thead><tr><th>店名</th><th>城市</th><th>人均</th><th class="hide-sm">点评</th><th>操作</th></tr></thead><tbody>' +
        (d.items || []).map((s) => '<tr><td>' + esc(s.name) + '<div class="hint" style="margin:0">' + esc(s.cuisine) + '</div></td>' +
          '<td>' + esc(s.city) + ' ' + esc(s.district) + '</td><td>' + yen(s.avg_price) + '</td>' +
          '<td class="hide-sm">' + num(s.review_count) + ' 条</td>' +
          '<td><div class="btnrow"><button class="btn sm" type="button" data-shopedit="' + s.id + '">编辑</button>' +
          '<a class="btn sm" href="/shop/' + esc(s.slug) + '" target="_blank" rel="noopener">看</a>' +
          '<button class="btn sm d" type="button" data-shopdel="' + s.id + '">删</button></div></td></tr>').join('') +
        '</tbody></table></div>' +
        '<div class="btnrow" style="margin-top:11px"><button class="btn a" type="button" id="shopnew">+ 加一家店</button>' +
        '<button class="btn" type="button" id="shoprefresh">刷新</button></div>' +
        '<div id="shopformwrap" style="margin-top:11px"></div>';
      document.getElementById('shopnew').addEventListener('click', () => showShopForm(null));
      document.getElementById('shoprefresh').addEventListener('click', vShops);
      panel.querySelectorAll('[data-shopedit]').forEach((b) => b.addEventListener('click', () => {
        const id = Number(b.getAttribute('data-shopedit'));
        showShopForm((d.items || []).find((x) => x.id === id));
      }));
      panel.querySelectorAll('[data-shopdel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删掉这家店？挂着的点评会保留，但会断掉店铺关联。')) return;
        try { await api.del('/api/admin/shops/' + b.getAttribute('data-shopdel')); L.toast('删掉了'); vShops(); }
        catch (e) { L.toast(e.message); }
      }));
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  function showShopForm(s) {
    curShop = s;
    const wrap = document.getElementById('shopformwrap');
    wrap.innerHTML = '<div class="box"><h4>' + (s ? '编辑店铺 #' + num(s.id) : '新增店铺') + '</h4><form class="adm-form" id="shopf">' +
      '<div class="row">' + inp('店名 *', 'name', s ? s.name : '') + inp('slug', 'slug', s ? s.slug : '') + '</div>' +
      '<div class="row">' + inp('城市', 'city', s ? s.city : '杭州') + inp('区/商圈', 'district', s ? s.district : '') +
      inp('菜系', 'cuisine', s ? s.cuisine : '') + inp('人均（元）', 'avg_price', s ? s.avg_price : 0, 'type="number" min="0"') + '</div>' +
      inp('地址', 'address', s ? s.address : '') +
      inp('营业时间', 'hours', s ? s.hours : '') +
      '<div class="row">' + inp('抖音链接', 'douyin_url', s ? s.douyin_url : '') + inp('小红书链接', 'xhs_url', s ? s.xhs_url : '') + '</div>' +
      inp('封面图路径（/uploads/… 或 /img/…）', 'cover', s ? s.cover : '') +
      ta('备注（一句话讲清这家店）', 'note', s ? s.note : '', 3) +
      '<div class="btnrow"><button class="btn p" type="submit">保存</button><button class="btn" type="button" id="shopcancel">取消</button></div>' +
      '</form></div>';
    document.getElementById('shopcancel').addEventListener('click', () => { wrap.innerHTML = ''; });
    document.getElementById('shopf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        id: s ? s.id : 0,
        name: f.elements.name.value.trim(),
        slug: f.elements.slug.value.trim(),
        city: f.elements.city.value.trim(),
        district: f.elements.district.value.trim(),
        address: f.elements.address.value.trim(),
        cuisine: f.elements.cuisine.value.trim(),
        avg_price: Number(f.elements.avg_price.value || 0),
        hours: f.elements.hours.value.trim(),
        douyin_url: f.elements.douyin_url.value.trim(),
        xhs_url: f.elements.xhs_url.value.trim(),
        cover: f.elements.cover.value.trim(),
        note: f.elements.note.value.trim(),
      };
      if (!body.name) { L.toast('店名不能空'); return; }
      try {
        if (s) await api.put('/api/admin/shops/' + s.id, body);
        else await api.post('/api/admin/shops', body);
        L.toast('存好了');
        shopOptions = []; // 店铺名可能变了，下回重新拉
        vShops();
      } catch (err) { L.toast(err.message); }
    });
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- 标签 ---------------- */
  async function vTastes() {
    shell('tastes', load('正在读标签…'));
    const panel = document.getElementById('panel');
    try {
      const list = await api.get('/api/admin/tastes');
      const rows = list.map((t) => '<tr><td>' + esc(t.name) + '<div class="hint" style="margin:0">' + esc(t.slug) + '</div></td>' +
        '<td>' + (t.kind === 'scene' ? '场景' : '口味') + '</td><td>' + num(t.sort_no) + '</td><td>' + num(t.count) + '</td>' +
        '<td><div class="btnrow"><button class="btn sm" type="button" data-tedit="' + t.id + '">改</button>' +
        '<a class="btn sm" href="/rank?taste=' + encodeURIComponent(t.slug) + '" target="_blank" rel="noopener">看</a>' +
        '<button class="btn sm d" type="button" data-tdel="' + t.id + '">删</button></div></td></tr>').join('');
      panel.innerHTML = '<div class="box"><h4>共 ' + num(list.length) + ' 个标签</h4>' +
        '<table class="adm-t"><thead><tr><th>名字</th><th>类型</th><th>排序</th><th>挂了几条</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div id="tasteformwrap" style="margin-top:11px"></div>' +
        '<div class="btnrow" style="margin-top:11px"><button class="btn a" type="button" id="tastenew">+ 加标签</button></div>';
      document.getElementById('tastenew').addEventListener('click', () => showTasteForm(null));
      panel.querySelectorAll('[data-tedit]').forEach((b) => b.addEventListener('click', () => {
        showTasteForm(list.find((x) => String(x.id) === b.getAttribute('data-tedit')));
      }));
      panel.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删标签会同时解掉它和点评的绑定，确定？')) return;
        try { await api.del('/api/admin/tastes/' + b.getAttribute('data-tdel')); L.toast('删掉了'); vTastes(); }
        catch (e) { L.toast(e.message); }
      }));
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  function showTasteForm(t) {
    const wrap = document.getElementById('tasteformwrap');
    wrap.innerHTML = '<div class="box"><h4>' + (t ? '改标签 #' + num(t.id) : '新增标签') + '</h4><form class="adm-form" id="tastef">' +
      '<div class="row">' + inp('名字 *', 'name', t ? t.name : '') + inp('slug（英文，留空自动）', 'slug', t ? t.slug : '') +
      sel('类型', 'kind', t ? t.kind : 'taste', [['taste', '口味'], ['scene', '场景']]) +
      inp('排序（小的在前）', 'sort_no', t ? t.sort_no : 50, 'type="number"') + '</div>' +
      '<div class="btnrow"><button class="btn p" type="submit">保存</button><button class="btn" type="button" id="tastecancel">取消</button></div>' +
      '</form></div>';
    document.getElementById('tastecancel').addEventListener('click', () => { wrap.innerHTML = ''; });
    document.getElementById('tastef').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        id: t ? t.id : 0,
        name: f.elements.name.value.trim(),
        slug: f.elements.slug.value.trim(),
        kind: f.elements.kind.value,
        sort_no: Number(f.elements.sort_no.value || 0),
      };
      if (!body.name) { L.toast('名字不能空'); return; }
      try {
        if (t) await api.put('/api/admin/tastes/' + t.id, body);
        else await api.post('/api/admin/tastes', body);
        L.toast('存好了');
        vTastes();
      } catch (err) { L.toast(err.message); }
    });
  }

  /* ---------------- 站点配置 ---------------- */
  const LONG_KEYS = ['seo_description', 'ip_bio', 'ip_quote', 'announcement', 'footer_note', 'site_tagline'];
  const KEY_LABEL = {
    site_title: '站点名（顶栏）', site_tagline: '副标题', seo_description: 'SEO 描述',
    ip_name: 'IP 名字', ip_handle: 'IP 账号名', ip_avatar: 'IP 头像路径', ip_city: 'IP 城市',
    ip_quote: 'IP 一句话', ip_bio: 'IP 简介', fans_display: '粉丝数展示', douyin_url: '抖音主页',
    xhs_url: '小红书主页', announcement: '公告（首页弹幕带）', footer_note: '页脚署名',
    mp_qrcode: '小程序码图片路径（/uploads/… 或 /img/…，留空首页不显示）',
    page_size: '每页条数', track_enabled: '统计开关（1/0）', allow_bots: '允许收录机器人（1/0）',
    icp: 'ICP 备案号（页脚展示，留空不显示）',
  };
  async function vSettings() {
    shell('settings', load('正在读配置…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/settings');
      const s = d.settings || {};
      panel.innerHTML = '<div class="box"><h4>站点与 IP 文案（改完点保存，前台立刻生效）</h4><form class="adm-form" id="setf">' +
        (d.keys || []).map((k) => LONG_KEYS.indexOf(k) >= 0 ? ta(KEY_LABEL[k] || k, k, s[k], 3) : inp(KEY_LABEL[k] || k, k, s[k])).join('') +
        (d.keys && d.keys.indexOf('mp_qrcode') >= 0
          ? '<label>上传小程序码图片（传好自动填路径，再点保存）<input type="file" id="mpqrup" accept="image/*"></label>'
          : '') +
        '<div class="btnrow"><button class="btn p" type="submit">保存全部</button>' +
        '<span class="hint" style="margin:0">只有白名单里的 key 会写库</span></div></form></div>';
      const mpUp = document.getElementById('mpqrup');
      if (mpUp) mpUp.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        L.toast('正在传小程序码…');
        try {
          const up = await api.form('/api/admin/upload', fd);
          const el = document.getElementById('setf').elements['mp_qrcode'];
          if (el) el.value = up.path;
          L.toast('路径已填上，点「保存全部」生效');
        } catch (err) { L.toast(err.message); }
        e.target.value = '';
      });
      document.getElementById('setf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const settings = {};
        (d.keys || []).forEach((k) => { settings[k] = f.elements[k] ? String(f.elements[k].value) : ''; });
        try { await api.put('/api/admin/settings', { settings: settings }); L.toast('存好了'); }
        catch (err) { L.toast(err.message); }
      });
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  /* ---------------- 图库 ---------------- */
  async function vUploads() {
    shell('uploads', load('正在读图库…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/uploads?size=200');
      const items = d.items || [];
      const s = d.storage || {};
      panel.innerHTML = '<div class="box"><h4>图库 · ' + num(items.length) + ' 个文件 · ' + bsize(s.upload_bytes) + '</h4>' +
        '<div class="btnrow" style="margin-bottom:10px">' +
        '<input type="file" id="gup" accept="image/*"><span class="hint" style="margin:0">上传会压成展示图 + 缩略图，EXIF 清掉</span>' +
        '<button class="btn" type="button" id="gpurge">清没用的图（3 天前）</button></div>' +
        (items.length ? '<div class="thumbs">' + items.map((u) =>
          '<div class="t"><img src="' + L.img(u.thumb || u.path) + '" alt="" loading="lazy">' +
          '<div class="m"><span class="nowrap">' + bsize(u.bytes + u.thumb_bytes) + '</span>' +
          '<span class="pill ' + (u.used_by > 0 ? 'ok' : 'no') + '">' + (u.used_by > 0 ? '用着 ' + num(u.used_by) : '没人用') + '</span></div>' +
          '<div class="m"><button class="btn sm" type="button" data-copy="' + esc(u.path) + '">复制路径</button>' +
          '<button class="btn sm d" type="button" data-udel="' + num(u.id) + '">删</button></div></div>').join('') + '</div>'
          : '<div class="hint">图库是空的，先在点评里传一张。</div>') + '</div>';
      document.getElementById('gup').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        L.toast('正在压图上传…');
        try { const r = await api.form('/api/admin/upload', fd); L.toast(r.saved_note || '传好了'); vUploads(); }
        catch (err) { L.toast(err.message); }
      });
      document.getElementById('gpurge').addEventListener('click', async () => {
        if (!confirm('删掉 3 天以上没人引用的图片？')) return;
        try {
          const r = await api.post('/api/admin/maintenance', { action: 'purge' });
          L.toast('清了 ' + num(r.deleted) + ' 个，回收 ' + bsize(r.freed_bytes));
          vUploads();
        } catch (e) { L.toast(e.message); }
      });
      panel.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
        const p = b.getAttribute('data-copy');
        try { await navigator.clipboard.writeText(p); L.toast('路径已复制'); } catch (e) { L.toast(p); }
      }));
      panel.querySelectorAll('[data-udel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删这张图？还在被点评引用的会拒绝。')) return;
        try { await api.del('/api/admin/uploads/' + b.getAttribute('data-udel')); L.toast('删掉了'); vUploads(); }
        catch (e) { L.toast(e.message); }
      }));
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  /* ---------------- 维护 ---------------- */
  async function vMaint() {
    shell('maint', '<div class="box"><h4>维护动作</h4>' +
      '<div class="btnrow">' +
      '<button class="btn" type="button" data-act="flush">落盘统计增量</button>' +
      '<button class="btn" type="button" data-act="prune">清理过期聚合</button>' +
      '<button class="btn" type="button" data-act="vacuum">VACUUM 压实库</button>' +
      '<button class="btn" type="button" data-act="purge">清孤儿图片</button>' +
      '<a class="btn a" href="/api/admin/export">导出内容 JSON</a></div>' +
      '<div class="hint">清理每天自动跑一次；这里的按钮是手动立刻执行。</div>' +
      '<div id="maintout" class="hint"></div></div>' +
      '<div class="box" style="margin-top:11px"><h4>怎么把数据搬走</h4>' +
      '<div class="hint" style="margin:0">内容：上面「导出内容 JSON」。整库：停服务后拷 <code>data/latiaomei.db</code>（连同 -wal）。图片：<code>data/uploads/</code>。</div></div>');
    const out = document.getElementById('maintout');
    document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.getAttribute('data-act');
      b.disabled = true;
      out.textContent = '正在跑 ' + act + ' …';
      try {
        const r = await api.post('/api/admin/maintenance', { action: act });
        out.textContent = act + ' 完成：' + JSON.stringify(r.detail || r).slice(0, 300);
      } catch (e) { out.textContent = act + ' 失败：' + e.message; }
      b.disabled = false;
    }));
  }

  /* ---------------- 路由 ---------------- */
  const VIEWS = { overview: vOverview, reviews: vReviews, shops: vShops, tastes: vTastes, settings: vSettings, uploads: vUploads, maint: vMaint };
  function render() {
    if (!csrf) { loginView(''); return; }
    const name = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    const fn = VIEWS[name] || VIEWS.overview;
    fn().catch((e) => {
      shell(name, errBox(e));
    });
  }

  window.addEventListener('hashchange', render);

  (async function init() {
    try {
      const s = await api.get('/api/admin/session');
      csrf = s.csrf;
      me = s.username;
      if (!csrf) { loginView('会话缺 CSRF 令牌，重新登录一下'); return; }
      if (!location.hash) location.hash = '#/overview';
      render();
    } catch (e) {
      loginView(e.status === 401 ? '' : e.message);
    }
  })();
})();
