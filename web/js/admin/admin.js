/* =============================================================
   admin.js —— 后台。左侧菜单，hash 路由：#/overview #/video（视频工坊，
   #/video?id=N 进工作区）#/release #/tasks #/cmd #/reviews #/shops #/tastes
   #/settings #/uploads #/maint。所有写操作都带 CSRF 头。
   v14 干活台：项目/待放行/任务/指令 与管理小程序同源同接口，状态全在服务端。
   v15 皮肤：菜单挪到左侧栏；「视频工坊」独立成一级菜单，列表用卡片，
   工作区双栏（左：说明/素材/跑一步，右：步骤时间线）。手机和电脑操作同一
   个项目工作区：往里加图片素材、改提示词、分步跑，两边接力互不等待。
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

  /* ---------------- 骨架：左侧菜单 ---------------- */
  const NAV_GROUPS = [
    ['看数据', [['overview', '📈', '概览']]],
    ['视频内容', [['video', '🎬', '视频工坊'], ['release', '🚦', '待放行'],
      ['tasks', '🛠', '任务队列'], ['cmd', '📣', '指令台账']]],
    ['内容管理', [['reviews', '🌶', '点评'], ['shops', '🏪', '店铺'],
      ['tastes', '🏷', '标签'], ['uploads', '🖼', '图库']]],
    ['站点', [['settings', '⚙', '站点配置'], ['maint', '🧹', '维护']]],
  ];
  function sideHTML(active) {
    return NAV_GROUPS.map((g) =>
      '<div class="grp">' + g[0] + '</div>' + g[1].map((n) =>
        '<button type="button" class="nav' + (n[0] === active ? ' on' : '') + '" data-nav="' + n[0] + '">' +
        '<i>' + n[1] + '</i>' + n[2] + '<span class="bdg" data-bdg="' + n[0] + '" hidden></span></button>').join('')).join('') +
      '<div class="side-foot"><a href="/" target="_blank" rel="noopener">↗ 看前台站点</a>' +
      '<button type="button" data-logout>⏻ 退出登录</button></div>';
  }
  function shell(active, body) {
    root.innerHTML = '<div class="adm-top"><div class="mt">' + L.mascot({ mouth: 'open' }) + '</div>' +
      '<div class="brand"><b>辣条妹 · 管理台</b><small>LATIAOMEI CONSOLE</small></div>' +
      '<div class="sp"><span class="who">' + esc(me) + '</span>' +
      '<a class="btn sm" href="/" target="_blank" rel="noopener">看前台</a>' +
      '<button class="btn sm d" type="button" data-logout>退出</button></div></div>' +
      '<div class="adm-shell"><aside class="adm-side">' + sideHTML(active) + '</aside>' +
      '<main class="adm-main"><div class="panel" id="panel">' + body + '</div></main></div>';
    root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.getAttribute('data-nav'); }));
    root.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post('/api/admin/logout'); } catch (e) { /* 退出失败也要回登录页 */ }
      csrf = ''; me = '';
      L.toast('已退出');
      loginView('');
    }));
    refreshBadges();
  }
  // 侧栏角标：待放行 / 排队任务 / 进行中项目，进页面时刷一次即可。
  function setBdg(key, v) {
    const el = root.querySelector('[data-bdg="' + key + '"]');
    if (!el) return;
    v = num(v);
    if (v > 0) { el.textContent = v > 99 ? '99+' : String(v); el.hidden = false; } else { el.hidden = true; }
  }
  async function refreshBadges() {
    try {
      const [rel, tk, pj] = await Promise.all([
        api.get('/api/admin/social-items?status=pending&limit=1'),
        api.get('/api/admin/tasks?status=pending&limit=1'),
        api.get('/api/admin/projects?status=open&limit=200'),
      ]);
      const s = rel.summary || {};
      setBdg('release', num(s.pending));
      const t = tk.summary || {};
      setBdg('tasks', num(t.pending) + num(t.running));
      setBdg('video', (pj.projects || []).length);
    } catch (e) { /* 角标拉不到不碍事 */ }
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
      '<button class="btn p" type="button" data-nav="video">去视频工坊</button>' +
      '<button class="btn" type="button" data-nav="release">待放行</button>' +
      '<button class="btn" type="button" data-nav="tasks">任务队列</button>' +
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
  const PIPE_KEYS = [
    ['pipeline_enabled', '总开关：发布后自动产四平台待审文案'],
    ['pipeline_xiaohongshu', '小红书文案'],
    ['pipeline_zhihu', '知乎文案'],
    ['pipeline_weibo', '微博文案'],
    ['pipeline_douyin', '抖音文案（需成片+cookie）'],
    ['pipeline_video', '视频渲染'],
    ['pipeline_gzh', '公众号同步发文'],
    ['pipeline_wxpush', '订阅消息推送'],
    ['pipeline_happyhorse', '人物镜头 happyhorse 生视频（项目制）'],
  ];
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
      panel.innerHTML = '<div class="box"><h4>AI 流水线开关（与小程序设置页同源，改完点保存）</h4>' +
        '<div class="mswrap" id="pipebox">' + PIPE_KEYS.map((k) =>
          '<label><input type="checkbox" data-pkey="' + k[0] + '"' + (String(s[k[0]]) === '1' ? ' checked' : '') + '>' + esc(k[1]) + '</label>').join('') + '</div>' +
        '<div class="btnrow" style="margin-top:8px">' + inp('每日成片上限（video_daily_cap）', 'vdcap', s.video_daily_cap || '0', 'type="number" style="max-width:160px"') +
        '<button class="btn p" type="button" id="pipesave">保存流水线开关</button>' +
        '<span class="hint" style="margin:0">四平台开关只产待审稿，放行才发</span></div></div>' +
        '<div class="box" style="margin-top:11px"><h4>站点与 IP 文案（改完点保存，前台立刻生效）</h4><form class="adm-form" id="setf">' +
        (d.keys || []).map((k) => LONG_KEYS.indexOf(k) >= 0 ? ta(KEY_LABEL[k] || k, k, s[k], 3) : inp(KEY_LABEL[k] || k, k, s[k])).join('') +
        (d.keys && d.keys.indexOf('mp_qrcode') >= 0
          ? '<label>上传小程序码图片（传好自动填路径，再点保存）<input type="file" id="mpqrup" accept="image/*"></label>'
          : '') +
        '<div class="btnrow"><button class="btn p" type="submit">保存全部</button>' +
        '<span class="hint" style="margin:0">只有白名单里的 key 会写库</span></div></form></div>';
      const mpUp = document.getElementById('mpqrup');
      document.getElementById('pipesave').addEventListener('click', async () => {
        const settings = {};
        document.querySelectorAll('#pipebox [data-pkey]').forEach((x) => { settings[x.getAttribute('data-pkey')] = x.checked ? '1' : '0'; });
        const capEl = document.getElementById('setf').elements.vdcap;
        if (capEl && capEl.value !== '') settings.video_daily_cap = String(Number(capEl.value) || 0);
        try { await api.put('/api/admin/settings', { settings: settings }); L.toast('流水线开关已保存'); }
        catch (e) { L.toast(e.message); }
      });
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

  /* ============ 干活台（v14）：项目 / 待放行 / 任务 / 指令 ============ */
  const TS_LABEL = { pending: '排队中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' };
  const PROJ_ST = { open: '进行中', review: '等放行', done: '已交付', archived: '已归档' };
  const PLAT_OPTS = [['douyin', '抖音'], ['xiaohongshu', '小红书'], ['zhihu', '知乎'], ['weibo', '微博']];
  const PLAT_LABEL = { douyin: '抖音', xiaohongshu: '小红书', zhihu: '知乎', gzh: '公众号', wxpush: '订阅消息' };
  let opsTimer = null;
  function stopOpsPoll() { if (opsTimer) { clearTimeout(opsTimer); opsTimer = null; } }
  function scheduleOps(fn, ms) { stopOpsPoll(); opsTimer = setTimeout(fn, ms || 15000); }
  function hashParam(k) {
    const m = (location.hash.split('?')[1] || '').match(new RegExp('(?:^|&)' + k + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  const jarr = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? (JSON.parse(v || '[]') || []) : []);
  const tsPill = (st) => '<span class="pill ' + (st === 'done' ? 'ok' : st === 'failed' ? 'no' : st === 'running' ? 'run' : st === 'pending' ? 'wait' : '') + '">' + esc(TS_LABEL[st] || st) + '</span>';

  /* ---------------- 视频工坊：项目工作区列表 ---------------- */
  const pjf = { status: 'open' };
  async function vVideo() {
    shell('video', load('正在读项目…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/projects?status=' + pjf.status + '&limit=100');
      const list = d.projects || [];
      const cards = list.map((p) => {
        const last = p.last_step_kind
          ? esc(p.last_step_label || p.last_step_kind) + ' · ' + esc(TS_LABEL[p.last_step_status] || p.last_step_status)
          : '还没开跑';
        return '<div class="pjcard" data-open=' + num(p.id) + '>' +
          '<div class="r1"><b>' + esc(p.title) + '</b><span class="pill st-' + esc(p.status) + '">' + esc(PROJ_ST[p.status] || p.status) + '</span></div>' +
          '<div class="brief">' + (p.brief ? esc(p.brief) : '<i>（还没写制片提示词，进工作区补）</i>') + '</div>' +
          '<div class="r3"><span>🖼 ' + num(p.asset_count) + ' 素材</span><span class="dot"></span>' +
          '<span>👣 ' + num(p.step_count) + ' 步</span><span class="dot"></span><span>' + last + '</span></div>' +
          '<div class="r3">立项：' + esc(p.created_by || '—') + ' · ' + stamp(p.created_at) + '</div>' +
          '<div class="r4">' +
            '<button class="btn sm p" type="button" data-open=' + num(p.id) + '>进工作区 →</button>' +
            (p.status === 'archived'
              ? '<button class="btn sm" type="button" data-unarch=' + num(p.id) + '>恢复</button>'
              : '<button class="btn sm" type="button" data-arch=' + num(p.id) + '>归档</button>') +
            '<button class="btn sm d" type="button" data-pdel=' + num(p.id) + '>删</button>' +
          '</div></div>';
      }).join('');
      panel.innerHTML =
        '<div class="pghead"><h3>🎬 视频工坊</h3>' +
        '<div class="sub">一条视频 / 一组平台文案 = 一个项目工作区：往里加图片素材 → 出分镜 → 改分镜 → 出成片 → 出文案 → 待放行。' +
        '和管理小程序是<b>同一个工作区</b>——手机立项，这里点开接着跑；这里加的图，手机上也立刻看得到。</div>' +
        sel('状态', 'pjs', pjf.status, [['open', '进行中'], ['review', '等放行'], ['done', '已交付'], ['archived', '已归档'], ['all', '全部']]) +
        '<button class="btn" type="button" id="pjgo">筛</button>' +
        '<button class="btn a" type="button" id="pjnew">＋ 新立项</button></div>' +
        '<div class="pjlist">' + (cards || '<div class="box"><div class="hint" style="margin:0">这个筛法下还没有项目。点「新立项」开一个，或去手机上的管理小程序里开。</div></div>') + '</div>' +
        '<div id="pjnewwrap" style="margin-top:12px"></div>';
      document.getElementById('pjgo').addEventListener('click', () => { pjf.status = document.getElementById('pjs').value; vVideo(); });
      document.getElementById('pjnew').addEventListener('click', () => showProjectNew());
      panel.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = '#/video?id=' + b.getAttribute('data-open');
      }));
      panel.querySelectorAll('[data-arch]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await api.put('/api/admin/projects/' + b.getAttribute('data-arch'), { status: 'archived' }); L.toast('已归档'); vVideo(); }
        catch (err) { L.toast(err.message); }
      }));
      panel.querySelectorAll('[data-unarch]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await api.put('/api/admin/projects/' + b.getAttribute('data-unarch'), { status: 'open' }); L.toast('已恢复'); vVideo(); }
        catch (err) { L.toast(err.message); }
      }));
      panel.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删项目会连带删它的步骤记录（素材库原图不删），确定？')) return;
        try { await api.del('/api/admin/projects/' + b.getAttribute('data-pdel')); L.toast('删掉了'); vVideo(); }
        catch (err) { L.toast(err.message); }
      }));
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  const pjNew = { paths: [] };
  function showProjectNew() {
    pjNew.paths = [];
    const wrap = document.getElementById('pjnewwrap');
    wrap.innerHTML = '<div class="box"><h4>新立项 · 开一个视频内容工作区</h4>' +
      '<div class="hint" style="margin:0 0 8px">立项后进的是和手机小程序同一个工作区：哪边建的都行，另一边接着加图、改提示词、跑步骤。</div>' +
      '<form class="adm-form" id="pjnf">' +
      inp('标题 *', 'title', '') +
      ta('制片提示词（想要什么片子、重点、口吻…可先空着到工作区再补）', 'brief', '', 4) +
      '<label>首批素材（可多选，传完点「立项」一起带进项目）<input type="file" id="pjun" accept="image/*" multiple></label>' +
      '<div id="pjnstaged" class="thumbs"></div>' +
      '<div class="btnrow"><button class="btn p" type="submit">立项进工作区</button><button class="btn" type="button" id="pjncancel">算了</button></div></form></div>';
    const paintStaged = () => {
      document.getElementById('pjnstaged').innerHTML = pjNew.paths.map((p, i) =>
        '<div class="t"><img src="' + L.img(p) + '" alt=""><div class="m"><button class="btn sm d" type="button" data-stagedel=' + i + '>×</button></div></div>').join('');
      document.querySelectorAll('[data-stagedel]').forEach((b) => b.addEventListener('click', () => { pjNew.paths.splice(Number(b.getAttribute('data-stagedel')), 1); paintStaged(); }));
    };
    document.getElementById('pjun').addEventListener('change', async (e) => {
      for (const file of Array.from(e.target.files || [])) {
        const fd = new FormData(); fd.append('file', file);
        try { const up = await api.form('/api/admin/upload', fd); pjNew.paths.push(up.path); paintStaged(); }
        catch (err) { L.toast(file.name + '：' + err.message); }
      }
      e.target.value = '';
    });
    document.getElementById('pjncancel').addEventListener('click', () => { wrap.innerHTML = ''; });
    document.getElementById('pjnf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const title = f.elements.title.value.trim();
      if (!title) { L.toast('给项目起个标题'); return; }
      try {
        const p = await api.post('/api/admin/projects', { title: title, brief: f.elements.brief.value.trim(), images: pjNew.paths });
        L.toast('立项成功');
        location.hash = '#/video?id=' + num(p.id);
      } catch (err) { L.toast(err.message); }
    });
  }

  /* ---------------- 视频工坊：单项目工作区（双栏） ---------------- */
  const pr = { pid: 0, fPrompt: '', renderer: 'hyperframes', galleryOpen: false, gallery: [] };
  async function vProject() {
    const id = Number(hashParam('id')) || 0;
    if (!id) { location.hash = '#/video'; return; }
    const switching = id !== pr.pid;
    if (switching) { pr.pid = id; pr.fPrompt = ''; pr.galleryOpen = false; pr.gallery = []; }
    shell('video', load('正在读工作区…'));
    // shell 重绘了 panel 与侧栏（工坊列表/工作区共用「视频工坊」菜单项）。
    await renderProjectDetail(false);
  }
  async function renderProjectDetail(silent) {
    const panel = document.getElementById('panel');
    if (!panel) return;
    if (!silent) panel.innerHTML = load('正在读工作区…');
    let d;
    try { d = await api.get('/api/admin/projects/' + pr.pid); }
    catch (e) { panel.innerHTML = errBox(e); return; }
    const p = d.project || {}, assets = d.assets || [], steps = (d.steps || []).slice().reverse();
    const hasSb = steps.some((s) => s.kind === 'storyboard' && s.status === 'done');

    // 页头：标题 + 状态 + 双端同步提示
    const head = '<div class="pghead">' +
      '<a class="btn sm" href="#/video">← 工坊列表</a>' +
      '<h3>🎬 ' + esc(p.title) + '</h3>' +
      '<span class="pill st-' + esc(p.status || 'open') + '">' + esc(PROJ_ST[p.status] || p.status) + '</span>' +
      '<span style="font-size:10.5px;font-weight:900;color:#0a7a3d;background:#e6f7ec;border:2px solid #0a7a3d;border-radius:9px;padding:2px 8px">🔗 与小程序同一工作区，双端随时接力</span>' +
      '<div class="sub">#' + num(p.id) + ' · 立项：' + esc(p.created_by || '—') + ' · ' + stamp(p.created_at) + '</div></div>';

    // 工作区四块：a=说明 b=素材(加图加内容) c=跑一步 d=时间线；列数由 .wsgrid 网格区域随屏幕宽度自适应。
    let left = '<div class="box ws-a"><h4>项目说明</h4><div class="adm-form">' +
      inp('标题', 'prtitle', p.title) +
      ta('制片提示词（想要什么片子、重点、口吻…写完保存再跑）', 'prbrief', p.brief, 4) +
      '<div class="btnrow"><button class="btn p sm" type="button" id="prsave">保存说明</button>' +
      sel('状态', 'prstatus', p.status, Object.keys(PROJ_ST).map((k) => [k, PROJ_ST[k]])) +
      '<button class="btn sm" type="button" id="prsave2">只改状态</button>' +
      '<button class="btn sm d" type="button" id="prdel">删项目</button></div></div></div>';

    left += '<div class="box ws-b"><h4>素材 ' + num(assets.length) + ' 个 · 往里加图片就是加内容</h4>' +
      (assets.length ? '<div class="thumbs">' + assets.map((a) =>
        '<div class="t">' + (a.kind === 'image' ? '<img src="' + L.img(a.path) + '" alt="" loading="lazy">' : '<div class="hint" style="margin:0">📄 ' + esc(a.path.split('/').pop()) + '</div>') +
        '<div class="m"><span class="nowrap">' + stamp(a.created_at) + '</span><button class="btn sm d" type="button" data-adel=' + num(a.id) + '>×</button></div></div>').join('') + '</div>'
        : '<div class="hint">还没有素材。传菜品/店铺参考图，出分镜时按上传顺序用图；人物镜头会自动挂辣条妹定妆图。</div>') +
      '<div class="upzone" style="margin-top:9px"><input type="file" id="prup" accept="image/*" multiple><span>选图直接传进项目</span>' +
      '<button class="btn sm" type="button" id="prgal">' + (pr.galleryOpen ? '收起图库' : '从图库挑') + '</button></div>' +
      '<div id="prgalwrap">' + (pr.galleryOpen ? galleryHTML() : '') + '</div></div>';

    left += '<div class="box ws-c"><h4>跑一步（附加指令可空，写完分镜再跑下一步）</h4>' +
      '<div class="adm-form">' + inp('本轮附加指令（如：开场改锅铲特写）', 'prprompt', pr.fPrompt) +
      '<div class="row">' + sel('出片引擎', 'prrenderer', pr.renderer, [['hyperframes', 'hyperframes · 图文卡+旁白'], ['openmontage', 'openmontage · 纯动态剪辑']]) + '</div>' +
      '<div class="btnrow">' +
      '<button class="btn p" type="button" data-run="storyboard">① 出分镜</button>' +
      '<button class="btn p" type="button" data-run="video"' + (hasSb ? '' : ' disabled title="先跑一步出分镜"') + '>② 出成片</button>' +
      '<button class="btn p" type="button" data-run="copy">③ 出平台文案</button></div>' +
      '<div class="hint">跑完自动刷新（15s 轮询）；产物照旧只进「待放行」，放行才发。</div></div></div>';

    const right = '<div class="box ws-d"><h4>步骤留痕（新在前，跑坏重跑不丢历史）</h4><div class="tl">' +
      (steps.length ? steps.map(stepHTML).join('') : '<div class="hint">还没跑过任何步骤。左边加好素材和提示词，回这边点「① 出分镜」开第一步。</div>') + '</div></div>';

    panel.innerHTML = head + '<div class="wsgrid">' + left + right + '</div>';
    bindProject(p, steps);

    const busy = steps.some((s) => s.status === 'pending' || s.status === 'running');
    if (busy) scheduleOps(() => { if (location.hash.indexOf('#/video') === 0) renderProjectDetail(true); }, 15000);
  }

  function galleryHTML() {
    if (!pr.gallery.length) return '<div class="hint">图库是空的。</div>';
    return '<div class="thumbs" style="max-height:260px;overflow:auto">' + pr.gallery.map((u) =>
      '<div class="t"><img src="' + L.img(u.thumb || u.path) + '" alt="" loading="lazy">' +
      '<div class="m"><button class="btn sm" type="button" data-gal="' + esc(u.path) + '">挂进来</button></div></div>').join('') + '</div>';
  }

  function stepHTML(s) {
    let r = null;
    try { r = JSON.parse(s.result || 'null'); } catch (e) { r = null; }
    const video = r && r.video ? r.video : '';
    const scenes = r && r.scenes ? r.scenes.length : 0;
    const items = r && r.items ? r.items : (r && r.item_id ? [r.item_id] : []);
    let acts = '<button class="btn sm" type="button" data-retry=' + num(s.id) + '>重跑这步</button>';
    if (s.kind === 'storyboard' && s.status === 'done' && s.result) {
      acts += ' <button class="btn sm" type="button" data-sbtoggle=' + num(s.id) + '>查看/改分镜</button>' +
        ' <button class="btn sm a" type="button" data-sbvideo=' + num(s.id) + '>用这版出成片</button>';
    }
    let detail = '';
    if (s.status === 'failed' && s.error) detail += '<div class="hint" style="color:var(--red)">✗ ' + esc(s.error) + '</div>';
    if (s.note) detail += '<div class="hint">' + esc(s.note) + '</div>';
    if (scenes) detail += '<span class="pill">' + num(scenes) + ' 镜</span>';
    if (r && r.engine) detail += ' <span class="pill">' + esc(r.engine) + '</span>';
    if (items.length) detail += ' <span class="pill ok">待放行 ' + num(items.length) + ' 条</span> <a class="btn sm" href="#/release">去放行</a>';
    if (video) detail += '<div style="margin-top:8px"><video class="pre" src="' + L.img(video) + '" controls preload="metadata"></video>' +
      '<div class="btnrow"><a class="btn sm" href="' + esc(video) + '?dl=1" download>下载源文件</a>' +
      '<button class="btn sm" type="button" data-copyurl="' + esc(location.origin + video + '?dl=1') + '">复制下载链</button></div></div>';
    let sbEdit = '';
    if (s.kind === 'storyboard' && s.status === 'done' && s.result) {
      let pretty = s.result;
      try { pretty = JSON.stringify(JSON.parse(s.result), null, 1); } catch (e) { /* 原样 */ }
      sbEdit = '<div id="sb' + num(s.id) + '" hidden style="margin-top:8px"><textarea id="sbt' + num(s.id) + '" rows="12" style="width:100%;border:2.5px solid var(--line);border-radius:10px;padding:8px;font-size:12px">' + esc(pretty) + '</textarea>' +
        '<div class="btnrow"><button class="btn sm p" type="button" data-sbsave=' + num(s.id) + '>保存分镜</button>' +
        '<button class="btn sm a" type="button" data-sbsavevideo=' + num(s.id) + '>保存并用这版出成片</button></div></div>';
    }
    return '<div class="tl-item"><div class="hd"><b class="t">' + esc(s.kind_label || s.kind) + '</b>' + tsPill(s.status) +
      '<span class="hint" style="margin:0">' + stamp(s.created_at) + (s.finished_at ? ' → ' + stamp(s.finished_at) : '') + ' · ' + esc(s.created_by) + '</span></div>' +
      (s.prompt ? '<div class="hint">追加指令：' + esc(s.prompt) + '</div>' : '') +
      (detail ? '<div style="margin-top:6px">' + detail + '</div>' : '') +
      '<div class="act">' + acts + '</div>' + sbEdit + '</div>';
  }

  function bindProject(p, steps) {
    const panel = document.getElementById('panel');
    const el = (id) => document.getElementById(id);
    const promptEl = el('prprompt'), rendEl = el('prrenderer');
    if (promptEl) promptEl.addEventListener('input', () => { pr.fPrompt = promptEl.value; });
    if (rendEl) rendEl.addEventListener('change', () => { pr.renderer = rendEl.value; });
    el('prsave').addEventListener('click', async () => {
      try {
        await api.put('/api/admin/projects/' + pr.pid, { title: promptTrim('prtitle'), brief: el('prbrief').value });
        L.toast('已保存'); renderProjectDetail(true);
      } catch (e) { L.toast(e.message); }
    });
    el('prsave2').addEventListener('click', async () => {
      try { await api.put('/api/admin/projects/' + pr.pid, { status: el('prstatus').value }); L.toast('状态已更新'); renderProjectDetail(true); }
      catch (e) { L.toast(e.message); }
    });
    el('prdel').addEventListener('click', async () => {
      if (!confirm('删项目？步骤记录一起删（素材库原图不删）。')) return;
      try { await api.del('/api/admin/projects/' + pr.pid); L.toast('删掉了'); location.hash = '#/video'; }
      catch (e) { L.toast(e.message); }
    });
    el('prup').addEventListener('change', async (e) => {
      for (const file of Array.from(e.target.files || [])) {
        const fd = new FormData(); fd.append('file', file);
        try {
          const up = await api.form('/api/admin/upload', fd);
          await api.post('/api/admin/projects/' + pr.pid + '/assets', { path: up.path, kind: 'image' });
        } catch (err) { L.toast(file.name + '：' + err.message); }
      }
      e.target.value = ''; L.toast('素材已加进项目'); renderProjectDetail(true);
    });
    el('prgal').addEventListener('click', async () => {
      pr.galleryOpen = !pr.galleryOpen;
      if (pr.galleryOpen && !pr.gallery.length) {
        try { const d = await api.get('/api/admin/uploads?size=200'); pr.gallery = d.items || []; } catch (e) { pr.gallery = []; }
      }
      el('prgalwrap').innerHTML = pr.galleryOpen ? galleryHTML() : '';
      bindGallery();
    });
    bindGallery();
    panel.querySelectorAll('[data-adel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('从项目移除这个素材？（素材库原图不删）')) return;
      try { await api.del('/api/admin/projects/' + pr.pid + '/assets/' + b.getAttribute('data-adel')); renderProjectDetail(true); }
      catch (e) { L.toast(e.message); }
    }));
    panel.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => runStep(b.getAttribute('data-run'), 0)));
    panel.querySelectorAll('[data-sbvideo]').forEach((b) => b.addEventListener('click', () => runStep('video', Number(b.getAttribute('data-sbvideo')))));
    panel.querySelectorAll('[data-sbtoggle]').forEach((b) => b.addEventListener('click', () => {
      const box = document.getElementById('sb' + b.getAttribute('data-sbtoggle'));
      if (box) box.hidden = !box.hidden;
    }));
    panel.querySelectorAll('[data-sbsave]').forEach((b) => b.addEventListener('click', () => saveStoryboard(Number(b.getAttribute('data-sbsave')), false)));
    panel.querySelectorAll('[data-sbsavevideo]').forEach((b) => b.addEventListener('click', () => saveStoryboard(Number(b.getAttribute('data-sbsavevideo')), true)));
    panel.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post('/api/admin/project-steps/' + b.getAttribute('data-retry') + '/retry', {}); L.toast('已重跑，历史保留'); renderProjectDetail(true); }
      catch (e) { L.toast(e.message); }
    }));
    panel.querySelectorAll('[data-copyurl]').forEach((b) => b.addEventListener('click', async () => {
      const u = b.getAttribute('data-copyurl');
      try { await navigator.clipboard.writeText(u); L.toast('下载链已复制，手机浏览器粘贴即下'); } catch (e) { L.toast(u); }
    }));
  }
  const promptTrim = (id) => { const x = document.getElementById(id); return x ? x.value.trim() : ''; };
  function bindGallery() {
    document.querySelectorAll('[data-gal]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api.post('/api/admin/projects/' + pr.pid + '/assets', { path: b.getAttribute('data-gal'), kind: 'image' });
        L.toast('已挂进项目'); renderProjectDetail(true);
      } catch (e) { L.toast(e.message); }
    }));
  }
  async function saveStoryboard(stepId, thenVideo) {
    const ta = document.getElementById('sbt' + stepId);
    if (!ta) return;
    let v;
    try { v = JSON.parse(ta.value); } catch (e) { L.toast('JSON 不合法，别改坏了——改坏了就重出一版'); return; }
    try {
      await api.post('/api/admin/project-steps/' + stepId + '/save', { result: JSON.stringify(v) });
      if (thenVideo) await runStep('video', stepId);
      else { L.toast('分镜已保存，出成片时选「用这版」'); renderProjectDetail(true); }
    } catch (e) { L.toast(e.message); }
  }
  async function runStep(kind, sbStepId) {
    const body = { kind: kind };
    if (pr.fPrompt.trim()) body.prompt = pr.fPrompt.trim();
    if (kind === 'video') { body.renderer = pr.renderer; if (sbStepId) body.storyboard_step_id = sbStepId; }
    try {
      const r = await api.post('/api/admin/projects/' + pr.pid + '/steps', body);
      L.toast(({ storyboard: '出分镜', video: '出成片（渲染要几分钟，挂着就行）', copy: '出平台文案' })[kind] + '已开工 #' + num(r.step_id));
      pr.fPrompt = ''; renderProjectDetail(true);
    } catch (e) { L.toast(e.message); }
  }

  const SO_ST = { pending: ['待审', 'wait'], approved: ['已放行', 'run'], published: ['已发布', 'ok'], rejected: ['已驳回', 'no'], failed: ['发布失败', 'no'] };
  const socPill = (st) => { const x = SO_ST[st] || [st, '']; return '<span class="pill ' + x[1] + '">' + esc(x[0]) + '</span>'; };

  /* ---------------- 待放行（social_items 人审闸门） ---------------- */
  const sof = { status: 'pending', platform: '' };
  async function vRelease() {
    shell('release', load('正在读待放行…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/social-items?status=' + sof.status + '&platform=' + sof.platform + '&limit=60');
      const items = d.items || [], sum = d.summary || {};
      const chips = ['pending', 'approved', 'rejected', 'published', 'failed'].map((k) =>
        '<span>' + ({ pending: '待审', approved: '已放行', rejected: '已驳回', published: '已发布', failed: '发布失败' })[k] + ' ' + num(sum[k]) + '</span>').join('');
      const cards = items.map((it) => {
        const tags = jarr(it.tags).map((t) => '<span>#' + esc(t) + '</span>').join('');
        const imgs = jarr(it.images).map((p) => '<div class="t"><img src="' + L.img(p) + '" alt="" loading="lazy"></div>').join('');
        let acts = '';
        if (it.status === 'pending' || it.status === 'approved') {
          acts += '<button class="btn sm" type="button" data-edit=' + num(it.id) + '>改稿</button>';
        }
        if (it.status === 'pending' || it.status === 'rejected') {
          acts += '<button class="btn sm p" type="button" data-appr=' + num(it.id) + '>✔ 放行</button>';
        }
        if (it.status === 'pending' || it.status === 'approved') {
          acts += '<button class="btn sm d" type="button" data-rej=' + num(it.id) + '>驳回</button>';
        }
        return '<div class="tl-item" id="si' + num(it.id) + '"><div class="hd"><span class="pill">' + esc(it.platform_label || PLAT_LABEL[it.platform] || it.platform) + '</span>' +
          '<b class="t">' + esc(it.title || '(无标题)') + '</b>' + socPill(it.status) +
          '<span class="hint" style="margin:0">' + stamp(it.created_at) + (it.review_dish ? ' · 出自「' + esc(it.review_dish) + '」' : '') + '</span></div>' +
          '<div class="sbody" data-body=' + num(it.id) + '>' + esc(it.body) + '</div>' +
          (tags ? '<div class="tagrow">' + tags + '</div>' : '') +
          (imgs ? '<div class="thumbs" style="margin-top:6px">' + imgs + '</div>' : '') +
          (it.video ? '<video class="pre" src="' + L.img(it.video) + '" controls preload="metadata"></video>' : '') +
          (it.note ? '<div class="hint">备注：' + esc(it.note) + '</div>' : '') +
          (it.result ? '<div class="hint">结果：' + esc(String(it.result)).slice(0, 200) + '</div>' : '') +
          '<div class="act">' + acts + '</div>' +
          '<div class="siedit" id="sie' + num(it.id) + '" hidden><div class="adm-form">' + inp('标题', 'sititle', it.title) + ta('正文', 'sibody', it.body, 6) + inp('话题（逗号分隔）', 'sitags', jarr(it.tags).join(',')) +
          '<div class="btnrow"><button class="btn sm p" type="button" data-sisave=' + num(it.id) + '>存稿</button><button class="btn sm" type="button" data-sicancel=' + num(it.id) + '>取消</button></div></div></div></div>';
      }).join('');
      panel.innerHTML = '<div class="box"><h4>待放行 · 人审闸门（铁律：只有这里放行才会发布）</h4>' +
        '<div class="sumchips">' + chips + '</div>' +
        '<div class="btnrow">' +
        sel('状态', 'sost', sof.status, [['pending', '待审'], ['approved', '已放行'], ['published', '已发布'], ['rejected', '已驳回'], ['failed', '发布失败'], ['all', '全部']]) +
        sel('平台', 'sopl', sof.platform, [['', '全部平台']].concat(PLAT_OPTS)) +
        '<button class="btn" type="button" id="sogo">筛</button></div></div>' +
        '<div class="tl" style="margin-top:11px">' + (cards || '<div class="hint">这个筛法下没有稿子。</div>') + '</div>';
      document.getElementById('sogo').addEventListener('click', () => { sof.status = document.getElementById('sost').value; sof.platform = document.getElementById('sopl').value; vRelease(); });
      panel.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const box = document.getElementById('sie' + b.getAttribute('data-edit'));
        if (box) box.hidden = false;
      }));
      panel.querySelectorAll('[data-sicancel]').forEach((b) => b.addEventListener('click', () => {
        const box = document.getElementById('sie' + b.getAttribute('data-sicancel'));
        if (box) box.hidden = true;
      }));
      panel.querySelectorAll('[data-sisave]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-sisave');
        const box = document.getElementById('sie' + id);
        const tags = box.querySelector('[name=sitags]').value.split(/[,，\s]+/).filter(Boolean);
        try {
          await api.post('/api/admin/social-items/' + id + '/save', { title: box.querySelector('[name=sititle]').value.trim(), body: box.querySelector('[name=sibody]').value, tags: tags });
          L.toast('存好了'); vRelease();
        } catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-appr]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('放行后会自动入队发布到对应平台，确定？')) return;
        try { await api.post('/api/admin/social-items/' + b.getAttribute('data-appr') + '/approve', {}); L.toast('已放行，发布任务已入队（去「任务」盯进度）'); vRelease(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-rej]').forEach((b) => b.addEventListener('click', async () => {
        const note = prompt('驳回理由（可空，会连带撤掉未跑的发布任务）：') || '';
        try { await api.post('/api/admin/social-items/' + b.getAttribute('data-rej') + '/reject', { note: note }); L.toast('已驳回'); vRelease(); }
        catch (e) { L.toast(e.message); }
      }));
      const busy = items.some((it) => it.status === 'pending');
      if (busy) scheduleOps(() => { if (location.hash.indexOf('#/release') === 0) vRelease(); }, 30000);
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  /* ---------------- 任务队列 ---------------- */
  const ttf = { status: 'pending', type: '' };
  async function vTasks() {
    shell('tasks', load('正在读任务队列…'));
    const panel = document.getElementById('panel');
    try {
      const d = await api.get('/api/admin/tasks?status=' + ttf.status + '&type=' + ttf.type + '&limit=100');
      const tasks = d.tasks || [], sum = d.summary || {};
      if (!d.pipeline_on) {
        panel.innerHTML = '<div class="box"><b style="color:var(--red)">流水线没开：服务端没配 LATIAOMEI_PIPELINE_TOKEN，worker 进不来。</b><div class="hint">见 deploy/latiaomei.env.example。</div></div>'; return;
      }
      const rows = tasks.map((t) => '<tr><td>#' + num(t.id) + '</td>' +
        '<td>' + esc(t.type_label || t.type) + (t.project_id ? '<div class="hint" style="margin:0">项目 #' + num(t.project_id) + '</div>' : (t.review_dish ? '<div class="hint" style="margin:0">「' + esc(t.review_dish) + '」</div>' : '')) + '</td>' +
        '<td>' + tsPill(t.status) + '</td>' +
        '<td class="hide-sm">' + num(t.attempts) + '</td>' +
        '<td class="hide-sm" title="' + esc(String(t.error || t.result || '')) + '">' + esc(String(t.error || t.result || '').slice(0, 60)) + '</td>' +
        '<td class="hide-sm">' + stamp(t.created_at) + '</td>' +
        '<td><div class="btnrow">' +
        (t.status === 'failed' ? '<button class="btn sm" type="button" data-tretry=' + num(t.id) + '>重跑</button>' : '') +
        (t.status === 'pending' || t.status === 'running' || t.status === 'failed' ? '<button class="btn sm d" type="button" data-tskip=' + num(t.id) + '>跳过</button>' : '') +
        '</div></td></tr>').join('');
      panel.innerHTML = '<div class="box"><h4>任务队列 · worker 消费端在服务器上跑</h4>' +
        '<div class="sumchips">' + Object.keys(sum).map((k) => '<span>' + esc(k) + ' ' + num(sum[k]) + '</span>').join('') + '</div>' +
        '<div class="btnrow">' +
        sel('状态', 'ttst', ttf.status, [['pending', '排队中'], ['running', '执行中'], ['done', '已完成'], ['failed', '失败'], ['skipped', '已跳过'], ['all', '全部']]) +
        '<button class="btn" type="button" id="ttgo">筛</button>' +
        '<button class="btn a" type="button" id="ttenq">+ 手动补发一单</button></div></div>' +
        '<div class="box" style="margin-top:11px"><h4>' + num(tasks.length) + ' 条</h4>' +
        '<table class="adm-t"><thead><tr><th>#</th><th>类型</th><th>状态</th><th class="hide-sm">重试</th><th class="hide-sm">结果/错误</th><th class="hide-sm">时间</th><th>操作</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="7">空</td></tr>') + '</tbody></table></div>' +
        '<div id="ttenqwrap" style="margin-top:11px"></div>';
      document.getElementById('ttgo').addEventListener('click', () => { ttf.status = document.getElementById('ttst').value; vTasks(); });
      panel.querySelectorAll('[data-tretry]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post('/api/admin/tasks/' + b.getAttribute('data-tretry') + '/retry', {}); L.toast('已重新排队'); vTasks(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-tskip]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('跳过这个任务？')) return;
        try { await api.post('/api/admin/tasks/' + b.getAttribute('data-tskip') + '/skip', {}); L.toast('已跳过'); vTasks(); }
        catch (e) { L.toast(e.message); }
      }));
      document.getElementById('ttenq').addEventListener('click', () => {
        document.getElementById('ttenqwrap').innerHTML = '<div class="box"><h4>手动补发（四平台发布类必须走「待放行」，这里只能补基础任务）</h4>' +
          '<div class="adm-form"><div class="row">' +
          sel('类型', 'entype', 'gzh', [['draft', 'AI 产草稿'], ['gzh', '公众号同步'], ['wxpush', '订阅消息推送'], ['video', '视频渲染']]) +
          inp('点评 ID（草稿可填 0）', 'enrid', '0', 'type="number"') +
          '</div><div class="btnrow"><button class="btn p" type="button" id="ensub">入队</button></div></div></div>';
        document.getElementById('ensub').addEventListener('click', async () => {
          try {
            const r = await api.post('/api/admin/tasks', { type: document.getElementById('entype').value, review_id: Number(document.getElementById('enrid').value) || 0 });
            L.toast(r.added ? '已入队' : '同类型未终结任务已存在，没重复加');
            vTasks();
          } catch (e) { L.toast(e.message); }
        });
      });
      const busy = tasks.some((t) => t.status === 'pending' || t.status === 'running');
      if (busy) scheduleOps(() => { if (location.hash.indexOf('#/tasks') === 0) vTasks(); }, 15000);
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  /* ---------------- 指令与发任务（指挥中心） ---------------- */
  const cmf = { status: 'open', dKinds: [['topic', '点菜'], ['style', '口径'], ['promo', '推广'], ['block', '禁做']] };
  async function vCmd() {
    shell('cmd', load('正在读指令…'));
    const panel = document.getElementById('panel');
    try {
      const [d, rv] = await Promise.all([
        api.get('/api/admin/directives?status=' + cmf.status),
        api.get('/api/admin/reviews?status=published&page=1&size=100'),
      ]);
      const dirs = d.directives || [];
      const KIND_TEXT = { topic: '点菜', style: '口径', promo: '推广', block: '禁做' };
      const rows = dirs.map((x) => '<div class="tl-item"><div class="hd"><span class="pill">' + esc(KIND_TEXT[x.kind] || x.kind) + '</span><b class="t">' + esc(x.title) + '</b>' +
        '<span class="pill ' + (x.status === 'open' ? 'run' : x.status === 'done' ? 'ok' : 'no') + '">' + esc(({ open: '进行中', done: '已办', cancelled: '已取消' })[x.status] || x.status) + '</span>' +
        '<span class="hint" style="margin:0">' + esc(x.date || '') + ' · ' + esc(x.created_by) + '</span></div>' +
        (x.brief ? '<div class="hint">' + esc(x.brief) + '</div>' : '') +
        (x.result_note ? '<div class="hint">回话：' + esc(x.result_note) + '</div>' : '') +
        '<div class="act">' +
        (x.status === 'open' ? '<button class="btn sm p" type="button" data-done=' + num(x.id) + '>办完</button><button class="btn sm" type="button" data-cancel=' + num(x.id) + '>取消</button>' : '<button class="btn sm" type="button" data-reopen=' + num(x.id) + '>重新开</button>') +
        '<button class="btn sm d" type="button" data-ddel=' + num(x.id) + '>删</button></div></div>').join('');
      const rvOpts = (rv.items || []).map((x) => '<option value="' + num(x.id) + '">' + esc(x.dish) + '</option>').join('');
      panel.innerHTML =
        '<div class="box"><h4>指令台账 · 辣条妹发号施令的地方</h4>' +
        '<div class="btnrow">' + sel('状态', 'dmst', cmf.status, [['open', '进行中'], ['done', '已办'], ['cancelled', '已取消'], ['all', '全部']]) + '<button class="btn" type="button" id="dmggo">筛</button></div></div>' +
        '<div class="box" style="margin-top:11px"><h4>下新指令</h4><div class="adm-form"><div class="row">' +
        sel('类型', 'dkind', 'topic', cmf.dKinds) + inp('标题 *', 'dtitle', '') + '</div>' +
        ta('具体内容（可空）', 'dbrief', '', 2) +
        '<div class="btnrow"><button class="btn p" type="button" id="dadd">记下</button></div></div></div>' +
        '<div class="tl" style="margin-top:11px">' + (rows || '<div class="hint">没有指令。</div>') + '</div>' +
        '<div class="box" style="margin-top:11px"><h4>发分发任务（一条已发布内容 → 四平台备稿）</h4><div class="adm-form">' +
        '<label>选内容<select id="misrvid">' + rvOpts + '</select></label>' +
        '<label>平台<div class="tagrow">' + PLAT_OPTS.map((o) => '<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" value="' + o[0] + '" checked>' + o[1] + '</label>').join('') + '</div></label>' +
        inp('备注（可空）', 'misnote', '') +
        '<div class="btnrow"><button class="btn p" type="button" id="missub">发任务</button><span class="hint" style="margin:0">产完稿进「待放行」，不会直接发</span></div></div></div>';
      document.getElementById('dmggo').addEventListener('click', () => { cmf.status = document.getElementById('dmst').value; vCmd(); });
      document.getElementById('dadd').addEventListener('click', async () => {
        const title = document.querySelector('[name=dtitle]').value.trim();
        if (!title) { L.toast('指令得有个标题'); return; }
        try {
          await api.post('/api/admin/directives', { title: title, brief: document.querySelector('[name=dbrief]').value.trim(), kind: document.querySelector('[name=dkind]').value });
          L.toast('已记下'); vCmd();
        } catch (e) { L.toast(e.message); }
      });
      panel.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
        const note = prompt('办完回话（可空）：') || '';
        try { await api.post('/api/admin/directives/' + b.getAttribute('data-done') + '/status', { status: 'done', note: note }); vCmd(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post('/api/admin/directives/' + b.getAttribute('data-cancel') + '/status', { status: 'cancelled', note: '' }); vCmd(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post('/api/admin/directives/' + b.getAttribute('data-reopen') + '/status', { status: 'open', note: '' }); vCmd(); }
        catch (e) { L.toast(e.message); }
      }));
      panel.querySelectorAll('[data-ddel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删这条指令？')) return;
        try { await api.del('/api/admin/directives/' + b.getAttribute('data-ddel')); vCmd(); }
        catch (e) { L.toast(e.message); }
      }));
      document.getElementById('missub').addEventListener('click', async () => {
        const plats = Array.from(panel.querySelectorAll('.tagrow input[type=checkbox]:checked')).map((x) => x.value);
        const rid = Number(document.getElementById('misrvid').value) || 0;
        if (!plats.length) { L.toast('至少选一个平台'); return; }
        try {
          const r = await api.post('/api/admin/missions', { review_id: rid, platforms: plats, note: document.querySelector('[name=misnote]').value.trim() });
          L.toast(r.added ? '任务已入队，文案好了去「待放行」看' : '同内容已有未终结的生成任务，没重复加');
        } catch (e) { L.toast(e.message); }
      });
    } catch (e) { panel.innerHTML = errBox(e); }
  }

  /* ---------------- 路由 ---------------- */
  function vVideoRoute() { return hashParam('id') ? vProject() : vVideo(); }
  const VIEWS = { overview: vOverview, video: vVideoRoute, release: vRelease, tasks: vTasks, cmd: vCmd, reviews: vReviews, shops: vShops, tastes: vTastes, settings: vSettings, uploads: vUploads, maint: vMaint };
  function render() {
    if (!csrf) { loginView(''); return; }
    stopOpsPoll();
    const raw = location.hash.replace(/^#\/?/, '') || 'overview';
    const name = raw.split('?')[0];
    if (name === 'projects' || name === 'project') {
      // v15 起工坊统一走 #/video（老链子自动搬，带 id 就直进工作区）
      const q = raw.indexOf('?') >= 0 ? raw.slice(raw.indexOf('?')) : '';
      location.hash = '#/video' + q;
      return;
    }
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
