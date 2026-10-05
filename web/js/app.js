/* =============================================================
   app.js —— 路由 / 骨架 / 埋点。最后加载：依赖 core.js 与 pages.js
   ============================================================= */
(function () {
  'use strict';
  const L = window.LTM, P = window.PAGES;

  const app = document.getElementById('app');
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');

  const TABS = [
    { key: 'home', href: '/', icon: '🏠', text: '首页' },
    { key: 'yushanfang', href: '/yushanfang', icon: '🍳', text: '御膳房' },
    { key: 'tandian', href: '/tandian', icon: '🌶', text: '探店' },
    { key: 'shops', href: '/shops', icon: '🗺', text: '店铺' },
  ];

  // 路由表：pattern + 页面名 + 是否把第一个捕获组当 slug
  const ROUTES = [
    [/^\/$/, 'home'],
    [/^\/tandian$/, 'tandian'],
    [/^\/yushanfang$/, 'yushanfang'],
    [/^\/rank$/, 'rank'],
    [/^\/shops$/, 'shops'],
    [/^\/shop\/([^\/]+)$/, 'shop', true],
    [/^\/review\/([^\/]+)$/, 'review', true],
    [/^\/taste$/, 'taste'],
    [/^\/about$/, 'about'],
    [/^\/search$/, 'search'],
  ];

  function parse() {
    const u = new URL(location.href);
    const path = (u.pathname.replace(/\/+$/, '') || '/');
    const query = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    return { path: path, query: query };
  }

  function resolve(path) {
    for (const r of ROUTES) {
      const m = path.match(r[0]);
      if (m) return { name: r[1], slug: r[2] ? decodeURIComponent(m[1]) : '' };
    }
    return { name: 'notfound', slug: '' };
  }

  function nav(url, replace) {
    if (url === location.pathname + location.search) { render(); return; }
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
    render();
  }
  L.nav = nav; // pages.js 的搜索框要用

  function paintTop(page) {
    const parts = [];
    if (page.back) parts.push('<div class="mt" id="backbtn" role="button" aria-label="返回">' + L.mascot({ mouth: 'flat' }) + '</div>');
    else parts.push('<div class="mt">' + L.mascot({ mouth: 'open' }) + '</div>');
    parts.push('<div><div class="tt">' + L.esc(page.title || '') + '</div>' +
      (page.sub ? '<div class="ss">' + L.esc(page.sub) + '</div>' : '') + '</div>');
    if (!page.back) parts.push('<div class="stmp">' + L.stamp(32) + '</div>');
    // PC 专用：顶栏右侧的水平导航。移动端由 CSS 隐藏，仍走底部 tabbar。
    parts.push('<nav class="topnav" id="topnav"></nav>');
    topbar.innerHTML = parts.join('');
    const back = document.getElementById('backbtn');
    if (back) back.addEventListener('click', () => { if (history.length > 1) history.back(); else nav('/'); });
  }

  function paintTabs(active) {
    const html = TABS.map((t) =>
      '<a href="' + t.href + '"' + (t.key === active ? ' class="on"' : '') + ' data-track><i>' + t.icon + '</i>' + t.text + '</a>').join('');
    tabbar.innerHTML = html;
    // 同一份导航：PC 渲染到顶栏右侧，移动端渲染到底部 Tab（显隐见 main.css 的 900px 断点）。
    const topnav = document.getElementById('topnav');
    if (topnav) topnav.innerHTML = html;
  }

  let token = 0;
  async function render() {
    const t = ++token;
    const { path, query } = parse();
    const r = resolve(path);
    if (r.slug) query.slug = r.slug;

    // Tab 高亮：店铺页归店铺；榜单/口味/搜索/探店归探店；菜谱归御膳房；详情等页面自己的 tab 说了算（下方 paintTabs(page.tab)）。
    const pre = (r.name === 'shop' || r.name === 'shops') ? 'shops'
      : (r.name === 'rank' || r.name === 'taste' || r.name === 'search' || r.name === 'tandian') ? 'tandian'
      : r.name;
    paintTabs(pre);
    view.innerHTML = '<div class="loadmore"><span class="spin"></span>条总还在吃…</div>';
    document.body.classList.remove('has-dock');

    const fn = P[r.name] || P.notfound;
    try {
      const page = await fn(query);
      if (t !== token) return; // 期间又点了别的页面，丢弃这次结果
      paintTop(page);
      view.innerHTML = page.body || '';
      const SITE = '辣条妹的御膳房';
      document.title = (page.title && page.title !== SITE) ? page.title + ' · ' + SITE : SITE;
      const dock = document.getElementById('dock');
      dock.innerHTML = page.dock || '';
      document.body.classList.toggle('has-dock', !!page.dock);
      if (page.after) page.after(document);
      paintTabs(page.tab);
      window.scrollTo(0, 0);
      L.track(path + (location.search || ''));
    } catch (e) {
      if (t !== token) return;
      paintTop({ title: '出错了', sub: '请求没回来' });
      view.innerHTML = '<div class="empty"><div class="m">' + L.mascot({ eyes: 'dead', mouth: 'flat' }) + '</div>' +
        '<h5>这口没吃上</h5><p>' + L.esc(e.message || '未知错误') + '</p></div>' +
        '<div class="loadmore"><a href="/" data-track>回首页</a></div>';
    }
  }

  // 站内链接统一走 pushState；外链交给浏览器。
  document.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || a.target === '_blank' || /^(https?:|mailto:|tel:|#)/.test(href)) return;
    e.preventDefault();
    nav(href);
  });

  window.addEventListener('popstate', render);

  render();
})();
