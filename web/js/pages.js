/* =============================================================
   pages.js —— 各页面渲染。每个页面返回 {title, sub, back, tab, body, dock}
   app.js 负责把它塞进骨架、绑定跳转与埋点。
   ============================================================= */
window.PAGES = (function () {
  'use strict';
  const L = window.LTM;
  const esc = L.esc, num = L.num, yen = L.yen;

  // 构造带参数的链接，只带上确实用到的键。
  const link = (base, q) => {
    const p = new URLSearchParams();
    Object.keys(q || {}).forEach((k) => { if (q[k] !== '' && q[k] != null) p.set(k, q[k]); });
    const s = p.toString();
    return s ? base + '?' + s : base;
  };
  const sect = (title, more) => '<div class="sect"><h3>' + esc(title) + '</h3><div class="ln"></div>' +
    (more ? '<a class="more" href="' + esc(more.href) + '" data-track>' + esc(more.text) + '</a>' : '') + '</div>';

  /* 判决卡：首页「今日特写」和探店页共用 */
  function vcard(featured) {
    const t = L.tier(featured.tier);
    return '<div class="vcard t-' + esc(featured.tier) + '">' +
      '<div class="vh"><div class="m">' + L.mascot({ mouth: featured.tier === 'la' ? 'flat' : 'open', eyes: featured.tier === 'la' ? 'dead' : 'normal' }) + '</div>' +
      '<b>今日一字判决 · ' + esc(featured.tier_label || t.label) + '</b><div class="st">' + L.stamp(30) + '</div></div>' +
      '<div class="vw">' + esc(featured.tier_label || t.label) + '<small>' + esc(t.en) + '</small></div>' +
      '<div class="vp"><div class="pm"><img src="' + L.img(featured.cover) + '" alt="' + esc(featured.dish) + '" loading="lazy"></div></div>' +
      '<div class="vi"><span class="sh">' + esc(featured.shop ? featured.shop.name : (featured.kind_label || '')) + '</span>' +
      '<div class="dl">' + esc(featured.dish) + ' · ' + yen(featured.price) + '</div>' +
      '<div class="mtr">' + L.meter(featured.score) + '</div></div>' +
      '<div class="sw">↑ 今日特写</div>' +
      '<a class="tap" href="/review/' + esc(featured.slug) + '" data-track aria-label="看这条点评"></a></div>';
  }

  /* 推荐卡：首页「辣条妹今日推荐」，缩小版今日一字判决 */
  function recCard(r) {
    const t = L.tier(r.tier);
    const isYu = r.kind === 'yushanfang';
    return '<a class="rcard t-' + esc(r.tier) + '" href="/review/' + esc(r.slug) + '" data-track>' +
      '<div class="rh"><b>' + esc(isYu ? '御膳房 · 今日推荐' : '探店 · 今日推荐') + '</b><i class="st">' + L.stamp(24) + '</i></div>' +
      '<div class="rvw">' + esc(r.tier_label || t.label) + '<small>' + esc(t.en) + '</small></div>' +
      '<div class="rpm"><img src="' + L.img(r.cover) + '" alt="' + esc(r.dish) + '" loading="lazy"></div>' +
      '<div class="rinfo"><span class="sh nowrap">' + esc(r.shop ? r.shop.name : (r.kind_label || (isYu ? '御膳房' : '探店'))) + '</span>' +
      '<div class="dl">' + esc(r.dish) + ' · ' + yen(r.price) + '</div>' +
      '<div class="mtr">' + L.meter(r.score) + '</div></div></a>';
  }

  /* ============ 首页：IP Hero × Tab 转盘 + 今日推荐卡 ============ */
  async function home() {
    const d = await L.boot(true);
    const site = d.site || {};

    // 双转盘数据：御膳房转「家里做什么」，探店转「出去吃什么」。
    // 先取后台勾选进转盘池的（wheel=1）；整盘都被关光了就退回全部已发布，首页不空转。
    const wheelPool = (kind, sort) =>
      L.api.get('/api/reviews', { kind, sort, wheel: 1, size: 100 }).catch(() => ({ items: [] }))
        .then((p) => (p.items && p.items.length ? p
          : L.api.get('/api/reviews', { kind, sort, size: 100 }).catch(() => ({ items: [] }))));
    const [yuPage, tdPage] = await Promise.all([
      wheelPool('yushanfang', 'new'),
      wheelPool('tandian', 'hot'),
    ]);
    const toSegs = (items, isYu) => {
      const seen = {}, out = [];
      (items || []).forEach((r) => {
        if (!r || !r.dish || seen[r.dish]) return;
        seen[r.dish] = 1;
        out.push({
          label: r.dish, href: '/review/' + r.slug, tier: r.tier,
          sub: isYu ? (r.price > 0 ? '成本 ¥' + r.price + ' / 人份 · 她灶上的' : '她灶上的')
            : (r.shop ? r.shop.name : '街边踩的'),
        });
      });
      if (out.length > 12) { // 太多就均匀抽样 12 个，转盘才转得清
        const k = out.length / 12, sampled = [];
        for (let i = 0; i < 12; i++) sampled.push(out[Math.floor(i * k)]);
        return sampled;
      }
      return out;
    };
    const yuSegs = toSegs(yuPage.items, true), tdSegs = toSegs(tdPage.items, false);
    const tips = {
      yu: ['她灶上的菜 · 成本透明', '不好吃就自己加料', '比外卖干净，比餐厅便宜', '做坏了也没人扣分'],
      td: ['踩过的才敢推荐', '难吃的照写不误', '转三次还拉就别出门了', '比看评分靠谱']
    };
    // Tab 面板里的单个转盘：问题 + 盘 + 一句贴士
    const wheelPanel = (q, segs, side) => {
      const tip = tips[side] || tips.td;
      const rt = tip[Math.floor(Math.random() * tip.length)];
      return '<div class="wcard">' +
        '<small class="wq">' + esc(q) + '</small>' +
        (L.wheel(segs) || '<div class="wz-none">菜还没排满<br>过两天再来转</div>') +
        '<p class="wftip">🌶 ' + esc(rt) + '</p>' +
      '</div>';
    };

    // 第一屏：左边 IP Hero，右边转盘（Tab 切换，默认探店）。
    let body = '<section class="homemix">' +
      '<div class="hm-hero">' +
        '<img class="iimg" src="/img/latiaomei-hero.svg" alt="辣条妹：举锅铲指镜头的橙围裙 IP">' +
        '<div class="itx">' +
          '<div class="ik">LATIAOMEI · 只做杭州美食文化</div>' +
          '<h1>' + esc(site.site_title || '辣条妹的御膳房') + '</h1>' +
          '<p class="hb">🌶 10年老杭州外地人 · 吃遍杭州美食</p>' +
          '<p class="tg">' + esc(site.site_tagline || '10年吃遍杭州 · 只恰真的') + '</p>' +
          '<p class="qt">「' + esc(site.ip_quote || '') + '」</p>' +
          '<div class="who">' + (site.ip_avatar ? '<img src="' + L.img(site.ip_avatar) + '" alt="">' : '') +
            '<span>' + esc(site.ip_handle || '') + ' · ' + esc(site.ip_city || '') + ' · 粉丝 ' + esc(site.fans_display || '—') + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="hm-wheel">' +
        '<div class="wz-head"><h3>今天吃啥子<em>·</em>转一下</h3></div>' +
        '<div class="wtabs" role="tablist">' +
          '<button class="wt on" type="button" role="tab" aria-selected="true" data-w="td">🌶 探店</button>' +
          '<button class="wt" type="button" role="tab" aria-selected="false" data-w="yu">🍳 御膳房</button>' +
        '</div>' +
        '<div class="wpan on" data-w="td">' + wheelPanel('今天出去吃什么', tdSegs, 'td') + '</div>' +
        '<div class="wpan" data-w="yu">' + wheelPanel('今天家里做什么', yuSegs, 'yu') + '</div>' +
        (function () {
          const tastes = d.tastes || [];
          const moodsList = [
            { e: '🤤', n: '重口', t: '麻辣' }, { e: '😌', n: '养胃', t: '清淡' },
            { e: '🥵', n: '冒烟', t: '酸辣' }, { e: '🍚', n: '续命', t: '面食' },
          ];
          const fortuneTastes = tastes.length
            ? tastes
            : moodsList.map(function (m) { return { name: m.t, slug: m.t, count: 0 }; });
          const fi = Math.floor(Math.random() * fortuneTastes.length);
          const ft = fortuneTastes[fi] || { name: '随便', slug: '', count: 0 };
          const fortunes = [
            '条总掐指一算：今天该来口「' + esc(ft.name) + '」的',
            '今日运势：宜「' + esc(ft.name) + '」，忌嘴硬说随便',
            '你五行缺「' + esc(ft.name) + '」，补一口能续命',
            '今日宜：「' + esc(ft.name) + '」，忌说随便然后再嫌弃',
          ];
          const fortuneText = fortunes[fi % fortunes.length];
          return '<div class="wz-fortune">' +
            '<div class="wf-left">' +
              '<span class="wf-icon">🔮</span>' +
              '<span class="wf-txt">' + fortuneText + '</span>' +
              (ft.slug ? '<a href="/rank?taste=' + esc(ft.slug) + '" data-track>认命 →</a>' : '') +
            '</div>' +
            '<div class="wf-moods">' +
              moodsList.map(function (m) {
                return '<a href="/rank?taste=' + esc(m.t) + '" data-track>' +
                  '<i>' + m.e + '</i>' + esc(m.n) + '</a>';
              }).join('') +
            '</div>' +
          '</div>';
        })() +
      '</div>' +
    '</section>';

    // 辣条妹今日推荐：一字判决风格的小卡，特写优先、封神榜补位、新上桌兜底
    const recs = [];
    const pushR = (r) => { if (r && r.slug && !recs.some((x) => x.slug === r.slug)) recs.push(r); };
    pushR(d.featured);
    (d.top || []).forEach(pushR);
    (d.latest || []).forEach(pushR);
    const recList = recs.slice(0, 6);
    if (recList.length) {
      body += sect('辣条妹今日推荐', { href: '/rank', text: '全部' }) +
        '<div class="reclist">' + recList.map(recCard).join('') + '</div>';
    }
    // 小程序引流卡：后台「站点配置 → mp_qrcode」传了码才上墙，没配就不占位
    const mpqr = String(site.mp_qrcode || '').trim();
    if (mpqr) {
      body += sect('微信小程序 · 扫码开吃') +
        '<section class="mpcta">' +
          '<div class="mp-txt">' +
            '<span class="mp-badge">微信小程序</span>' +
            '<b>在微信里，随身问辣条妹</b>' +
            '<p>今天吃什么、这家能不能进、在杭三天怎么排——扫码进来，张嘴就行。</p>' +
            '<div class="mp-feats"><span>🌶 今天吃啥·转一下</span><span>📍 附近好店</span><span>🗓 几天怎么吃·帮你排</span></div>' +
          '</div>' +
          '<figure class="mp-qr"><img src="' + esc(mpqr) + '" alt="辣条妹的御膳房 · 微信小程序码" loading="lazy">' +
            '<figcaption>微信扫一扫 · 直达</figcaption></figure>' +
        '</section>';
    }
    body += foot(d);
    return { title: site.site_title || '辣条妹的御膳房', sub: '御膳房 × 探店 · 两把都只恰真的', tab: 'home', body: body, after: bindHome };
  }

  // 首页交互：转盘绑定 + 探店/御膳房 Tab 切换
  function bindHome(root) {
    L.bindWheels(root);
    const tabs = (root || document).querySelectorAll('.wtabs .wt');
    tabs.forEach((btn) => btn.addEventListener('click', () => {
      const w = btn.getAttribute('data-w');
      tabs.forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      (root || document).querySelectorAll('.wpan').forEach((p) =>
        p.classList.toggle('on', p.getAttribute('data-w') === w));
    }));
  }

  /* ============ 御膳房：辣条妹自己的菜谱 ============ */
  async function yushanfang(q) {
    const d = await L.boot();
    const page = await L.api.get('/api/reviews', { kind: 'yushanfang', sort: pickSort(q.sort), size: 100 });
    const items = page.items || [];
    const hangN = items.filter((r) => r.tier === 'hang' || r.tier === 'dingji').length;

    const seg = '<div class="seg">' +
      [['new', '最近做的'], ['score', '按好吃排'], ['hot', '最多人看']]
        .map((x) => '<a class="' + ((pickSort(q.sort) === x[0]) ? 'on' : '') + '" href="' +
          esc(link('/yushanfang', { sort: x[0] })) + '" data-track>' + x[1] + '</a>').join('') + '</div>';

    let body = '<section class="yu-band"><div class="ybe">' +
      '<img src="/img/latiaomei-hero.svg" alt="">' +
      '<div><h2>御膳房</h2><p>探店踩雷踩多了，只能自己开灶。<b>价格记的是单人份成本，「回头」在这边是她做过的次数。</b></p>' +
      '<div class="ychip">' + items.length + ' 道菜谱 · 封神 ' + hangN + ' 道 · 不定期更新</div></div>' +
      '</div></section>' + seg;

    body += items.length
      ? '<div class="list">' + items.map((r) => L.rvCard(r)).join('') + '</div>'
      : L.empty('灶台还冷着', '菜谱在后台发，主题选「御膳房」就会出现在这');
    body += foot(d);
    return { title: '御膳房 · 家常菜谱', sub: items.length + ' 道 · 她亲手做的', tab: 'yushanfang', body: body };
  }
  const pickSort = (s) => (s === 'score' || s === 'hot' ? s : 'new');

  /* ============ 探店（原首页内容） ============ */
  async function tandian() {
    const d = await L.boot(true);
    const c = d.counters || {};
    const site = d.site || {};
    const featured = d.featured;

    let head = '';
    if (featured) {
      head = vcard(featured);
    } else {
      head = L.empty('今天还没开张', '后台发一条点评，这里就出判决卡');
    }

    const dm = (d.latest || []).slice(0, 4).map((r) => '· ' + r.dish + ' · ' + L.tierLabel(r.tier)).concat(
      d.announcement ? ['· ' + d.announcement] : [], ['· 转发请标明出处 ·']);

    const counts = '<div class="counts">' +
      '<div><b>' + num(c.shops) + '</b><small>踩过的店</small></div>' +
      '<div><b>' + num(c.hang) + '</b><small>封神菜</small></div>' +
      '<div><b>' + num(c.la) + '</b><small>避雷菜</small></div>' +
      '<div><b>' + num(c.tastes) + '</b><small>口味标签</small></div></div>';

    const ent = '<div class="ent">' +
      '<a href="/rank" data-track><span class="ic">🏆</span><span><b>排行榜</b><small>封神 · 避雷 · 新开</small></span></a>' +
      '<a href="/rank?tier=la" data-track><span class="ic">💀</span><span><b>避雷区</b><small>谁去谁哭</small></span></a>' +
      '<a href="/shops" data-track><span class="ic">🗺</span><span><b>店铺档案</b><small>按城市逛</small></span></a>' +
      '<a href="/taste" data-track><span class="ic">🌶</span><span><b>口味筛选</b><small>想吃哪一口</small></span></a></div>';

    const top = (d.top || []).slice(0, 6);
    const latest = (d.latest || []).slice(0, 3);
    const avoid = (d.avoid || []).slice(0, 2);

    // PC 上「判决卡 | 统计+入口」并排；移动端 .home-top 只是一个普通块，顺序不变。
    let body = '<div class="home-top">' +
        '<div class="home-hero">' + head + '</div>' +
        '<div class="home-side">' + counts + ent + '</div>' +
      '</div>' +
      '<div class="dmband"><div>' + (dm.concat(dm)).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div></div>';

    if (top.length >= 3) {
      body += sect('本周封神榜', { href: '/rank', text: '全部' }) + L.podium(top.slice(0, 3)) +
        '<div class="list">' + top.slice(3, 6).map((r, i) => L.rkRow(r, i + 4)).join('') + '</div>';
    }
    if (latest.length) {
      body += sect('新上桌', { href: '/rank?sort=new', text: '更多' }) +
        '<div class="list">' + latest.map((r) => L.rvCard(r)).join('') + '</div>';
    }
    if (avoid.length) {
      body += sect('避雷区', { href: '/rank?tier=la', text: '全看' }) +
        '<div class="list">' + avoid.map((r) => L.rvCard(r)).join('') + '</div>';
    }
    body += foot(d);

    return { title: '探店 · 今日判决', sub: site.site_tagline || '10年吃遍杭州 · 只恰真的', tab: 'tandian', body: body };
  }

  function foot(d) {
    const site = d.site || {};
    const c = d.counters || {};
    const links = [];
    if (site.douyin_url) links.push('<a href="' + esc(site.douyin_url) + '" target="_blank" rel="noopener">抖音</a>');
    if (site.xhs_url) links.push('<a href="' + esc(site.xhs_url) + '" target="_blank" rel="noopener">小红书</a>');
    links.push('<a href="/about" data-track>评级标准</a>');
    links.push('<a href="/rank" data-track>排行榜</a>');
    links.push('<a href="/shops" data-track>店铺档案</a>');
    links.push('<a href="/taste" data-track>口味筛选</a>');
    const beian = site.icp
      ? '<div class="beian"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener nofollow">' + esc(site.icp) + '</a></div>'
      : '';
    const stats = (c.shops || c.published) ? '<div class="fstats">' +
      '<div><b>' + L.num(c.shops || 0) + '</b><span>踩过的店</span></div>' +
      '<div><b>' + L.num(c.published || 0) + '</b><span>条点评</span></div>' +
      '<div><b>' + L.num(c.hang || 0) + '</b><span>封神菜</span></div>' +
      '<div><b>' + L.num(c.views || 0) + '</b><span>次翻牌</span></div>' +
    '</div>' : '';
    return '<div class="foot">' +
      '<div class="fmain">' +
        '<div class="fmasc">' + L.mascot({ mouth: 'smile', eyes: 'heart' }) + '</div>' +
        '<div class="finfo">' +
          '<b>' + esc(site.footer_note || '辣条妹的御膳房 · 手工点评') + '</b>' +
          '<p>' + esc(site.ip_quote || '') + '</p>' +
          '<div class="links">' + links.join('') + '</div>' +
        '</div>' +
      '</div>' +
      stats +
      beian +
    '</div>';
  }

  /* ============ 排行榜 ============ */
  async function rank(q) {
    const d = await L.boot();
    const mode = q.tier === 'la' ? 'la' : (q.sort === 'new' ? 'new' : 'rank');
    const base = { tier: q.tier || '', taste: q.taste || '', city: q.city || '', q: q.q || '', page: q.page || 1 };
    const sort = mode === 'rank' ? 'rank' : 'new';
    const page = await L.api.get('/api/reviews', { tier: q.tier || '', taste: q.taste || '', city: q.city || '', q: q.q || '', sort: sort, page: q.page || 1, size: 12 });

    const seg = '<div class="seg">' +
      [[mode === 'rank', '封神榜', link('/rank', { taste: base.taste, city: base.city })],
       [mode === 'la', '避雷榜', link('/rank', { tier: 'la', taste: base.taste, city: base.city })],
       [mode === 'new', '新开店', link('/rank', { sort: 'new', taste: base.taste, city: base.city })]]
        .map((x) => '<a class="' + (x[0] ? 'on' : '') + '" href="' + esc(x[2]) + '" data-track>' + x[1] + '</a>').join('') + '</div>';

    const tierChips = [['', '全部'], ['hang', '夯'], ['dingji', '顶级'], ['renshang', '人上人'], ['npc', 'NPC'], ['la', '拉完了']]
      .map((t) => '<a class="' + (String(q.tier || '') === t[0] ? 'on' : '') + '" href="' +
        esc(link('/rank', Object.assign({}, base, { tier: t[0], page: 1 }))) + '" data-track>' + t[1] + '</a>').join('');
    const tasteChips = (d.tastes || []).map((t) => '<a class="' + (q.taste === t.slug ? 'on' : '') + '" href="' +
      esc(link('/rank', Object.assign({}, base, { taste: q.taste === t.slug ? '' : t.slug, page: 1 }))) + '" data-track>' + esc(t.name) + '</a>').join('');
    const cityChips = (d.cities || []).length > 1 ? (d.cities || []).map((c) => '<a class="' + (q.city === c ? 'on' : '') + '" href="' +
      esc(link('/rank', Object.assign({}, base, { city: q.city === c ? '' : c, page: 1 }))) + '" data-track>' + esc(c) + '</a>').join('') : '';

    let body = seg +
      '<div class="flt">' + tierChips + tasteChips + cityChips + '</div>' +
      '<div class="searchbar"><input id="q" type="search" placeholder="找菜名 / 店名 / 关键词" value="' + esc(q.q || '') + '">' +
      '<button id="qgo" type="button">搜</button></div>';

    if (!page.items.length) {
      body += L.empty('这个筛法下面啥也没有', '换个档位或者口味看看');
    } else if (mode === 'rank' && (page.page || 1) === 1 && !q.taste && !q.city && !q.q && page.items.length >= 3) {
      body += L.podium(page.items.slice(0, 3)) +
        '<div class="list">' + page.items.slice(3).map((r, i) => L.rkRow(r, i + 4)).join('') + '</div>';
    } else {
      const start = (num(page.page) - 1) * num(page.size);
      body += '<div class="list">' + page.items.map((r, i) => L.rkRow(r, start + i + 1)).join('') + '</div>';
    }
    if (page.has_more) {
      body += '<a class="loadmore" href="' + esc(link('/rank', Object.assign({}, base, { page: num(page.page) + 1 }))) + '" data-track>条总还在吃… 看下一页</a>';
    } else if (page.items.length) {
      body += '<div class="loadmore">到底了，共 ' + num(page.total) + ' 条</div>';
    }

    const titles = { rank: '排行榜 · 封神榜', la: '排行榜 · 避雷榜', new: '排行榜 · 新开店' };
    return { title: titles[mode], sub: 'TOP ' + num(page.total) + ' · 每周更新', tab: 'tandian', body: body, after: bindSearch };
  }

  function bindSearch(root) {
    const input = root.querySelector('#q'), btn = root.querySelector('#qgo');
    if (!input || !btn) return;
    const go = () => {
      const v = input.value.trim();
      const u = new URL(location.href);
      if (v) u.searchParams.set('q', v); else u.searchParams.delete('q');
      u.searchParams.delete('page');
      L.nav(u.pathname + u.search);
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  /* ============ 店铺列表 ============ */
  async function shops(q) {
    const d = await L.boot();
    const page = await L.api.get('/api/shops', { city: q.city || '', q: q.q || '', sort: q.sort || '', page: q.page || 1, size: 12 });
    const cityChips = [['', '全部城市']].concat((d.cities || []).map((c) => [c, c]))
      .map((c) => '<a class="' + (String(q.city || '') === c[0] ? 'on' : '') + '" href="' +
        esc(link('/shops', { city: c[0], q: q.q || '' })) + '" data-track>' + esc(c[1]) + '</a>').join('');
    let body = '<div class="flt" style="padding-top:12px">' + cityChips + '</div>' +
      '<div class="searchbar"><input id="q" type="search" placeholder="找店名 / 菜系 / 地址" value="' + esc(q.q || '') + '">' +
      '<button id="qgo" type="button">搜</button></div>';
    body += page.items.length
      ? '<div class="list">' + page.items.map(shopCard).join('') + '</div>'
      : L.empty('这里还没有店', '去后台加一家');
    if (page.has_more) body += '<a class="loadmore" href="' + esc(link('/shops', { city: q.city || '', q: q.q || '', page: num(page.page) + 1 })) + '" data-track>还有 ' + (num(page.total) - num(page.page) * num(page.size)) + ' 家… 看下一页</a>';
    return { title: '店铺档案', sub: '共 ' + num(page.total) + ' 家 · 按点评热度排', tab: 'shops', body: body, after: bindSearch };
  }

  function shopCard(s) {
    return '<a class="rv" href="/shop/' + esc(s.slug) + '" data-track>' +
      '<div class="ph"><img src="' + L.img(s.cover) + '" alt="' + esc(s.name) + '" loading="lazy">' +
      (s.la_count > 0 ? '<span class="vc t-la" style="left:-6px;top:-8px">拉</span>' : '') + '</div>' +
      '<div><h4>' + esc(s.name) + '</h4>' +
      '<div class="say nowrap">' + esc(s.note || s.cuisine || '') + '</div>' +
      '<div class="shopline">' + esc(s.city) + ' ' + esc(s.district) + ' · ' + esc(s.cuisine) + '</div>' +
      '<div class="mrow"><span class="g">人均 ' + yen(s.avg_price) + '</span>' +
      '<span class="g">' + num(s.review_count) + ' 条点评</span>' +
      (s.best_dish ? '<span class="g">招牌 ' + esc(s.best_dish) + '</span>' : '') + '</div></div></a>';
  }

  /* ============ 店铺详情 ============ */
  async function shop(q) {
    const slug = q.slug;
    const d = await L.api.get('/api/shops/' + encodeURIComponent(slug));
    const s = d.shop, reviews = d.reviews;
    let main = '<div class="shophead"><img src="' + L.img(s.cover) + '" alt="' + esc(s.name) + '" loading="lazy">' +
      '<div><h2>' + esc(s.name) + '</h2>' +
      '<div class="meta">' + esc(s.city) + ' ' + esc(s.district) + ' · ' + esc(s.cuisine) + ' · 人均 ' + yen(s.avg_price) + '</div>' +
      '<div class="meta">' + num(s.review_count) + ' 条点评 · 平均 ' + (num(s.avg_score) ? num(s.avg_score).toFixed(1) : '—') + ' 分</div>' +
      '<div class="mtr" style="display:flex;gap:3px;margin-top:4px">' + L.meter(s.avg_score) + '</div></div></div>';

    const rows = [];
    if (s.address) rows.push(['地址', esc(s.address)]);
    if (s.hours) rows.push(['营业', esc(s.hours)]);
    if (s.best_dish) rows.push(['招牌', esc(s.best_dish)]);
    if (s.douyin_url) rows.push(['抖音', '<a href="' + esc(s.douyin_url) + '" target="_blank" rel="noopener">看视频</a>']);
    if (s.xhs_url) rows.push(['小红书', '<a href="' + esc(s.xhs_url) + '" target="_blank" rel="noopener">看笔记</a>']);
    if (s.note) rows.push(['备注', esc(s.note)]);
    if (rows.length) main += '<div class="kv">' + rows.map((r) => '<div><b>' + r[0] + '</b><span>' + r[1] + '</span></div>').join('') + '</div>';

    // PC 上「店铺信息 | 这家店的菜」并排；移动端顺序不变。
    const body = '<div class="shop-wrap"><div class="shop-main">' + main + '</div>' +
      '<div class="shop-side">' + sect('这家店的菜', null) +
      (reviews.items.length
        ? '<div class="list">' + reviews.items.map((r) => L.rvCard(r, { noShop: true })).join('') + '</div>'
        : L.empty('还没有点评', '这家店的菜等着被写')) + '</div></div>' +
      '<div class="foot"><b>' + esc(s.name) + '</b><p>点评都是自己掏钱吃的，难吃的也照写。</p>' +
      '<div class="links"><a href="/shops" data-track>回到店铺列表</a></div></div>';
    return { title: s.name, sub: s.city + ' ' + s.district, back: true, tab: 'shops', body: body };
  }

  /* ============ 点评详情 ============ */
  async function review(q) {
    const d = await L.api.get('/api/reviews/' + encodeURIComponent(q.slug));
    const r = d.review, related = d.related || [];
    const t = L.tier(r.tier);
    const imgs = (r.images || []).filter(Boolean);
    const cover = r.cover || imgs[0] || '';
    const isYu = r.kind === 'yushanfang';

    let main = '<div class="hero3 t-' + esc(r.tier) + '">' +
      '<img src="' + L.img(cover) + '" alt="' + esc(r.dish) + '">' +
      '<span class="vd">' + esc(r.tier_label || t.label) + '</span>' +
      '<div class="stampw">' + L.stamp(62) + '</div>' +
      (r.price > 0 ? '<span class="line3">' + (isYu ? '成本 ' + yen(r.price) + ' / 人份' : yen(r.price) + ' / 份') + '</span>' : '') + '</div>';

    main += '<div class="detail"><div class="t3"><h2>' + esc(r.dish) + '</h2>';
    if (r.shop) {
      main += '<a class="shopline" style="font-size:12px;font-weight:800;color:var(--muted)" href="/shop/' + esc(r.shop.slug) + '" data-track>' +
        '📍 ' + esc(r.shop.name) + ' · ' + esc(r.shop.city) + esc(r.shop.district) + ' · 人均 ' + yen(r.shop.avg_price) + ' →</a>';
    }
    main += '<div class="chips">' +
      '<i class="kindchip ' + (isYu ? 'yu' : 'ta') + '">' + esc(r.kind_label || (isYu ? '御膳房' : '探店')) + '</i>' +
      (r.tastes || []).map((x) => '<i class="' + (x.kind === 'taste' ? 'hot' : '') + '">' + esc(x.name) + '</i>').join('') +
      (r.visit_date ? '<i>' + esc(r.visit_date) + (isYu ? ' 做的' : ' 吃的') + '</i>' : '') + '</div></div>';

    if (r.headline) {
      main += '<div class="say3"><div class="m">' + L.mascot({ mouth: r.tier === 'la' ? 'grit' : 'open', eyes: r.tier === 'la' ? 'angry' : 'normal' }) + '</div>' +
        '<div><small>条总毒舌一句</small><b>' + esc(r.headline) + '</b></div></div>';
    }

    main += '<div class="mrow3">' +
      '<span class="g">好吃 <span class="mtr">' + L.meter(r.score) + '</span> <b>' + num(r.score).toFixed(1) + '</b></span>' +
      '<span class="g">辣度 <span class="spr">' + L.spice(r.spicy) + '</span> <b>' + num(r.spicy) + '</b></span>' +
      '<span class="g">' + (isYu ? '做过' : '回头') + ' <b>' + num(r.revisit) + '</b> 次</span>' +
      '<span class="g">浏览 <b>' + num(r.view_count) + '</b></span>' + '</div>';

    if (r.order_tip) main += '<div class="tip4"><h6>' + (isYu ? '家常小灶 · 避坑贴士' : '隐藏吃法 · 点单建议') + '</h6><p>' + esc(r.order_tip) + '</p></div>';
    if (r.body) main += '<div class="body3">' + esc(r.body) + '</div>';
    if (imgs.length > 1) main += '<div class="gallery">' + imgs.map((s) => '<img src="' + L.img(s) + '" alt="' + esc(r.dish) + '" loading="lazy">').join('') + '</div>';
    main += '</div>';

    const wallLines = related.slice(0, 4).map((x) => ({
      who: (x.shop ? x.shop.name : (x.kind === 'yushanfang' ? '御膳房' : '路人')) + ' · ' + L.tierLabel(x.tier),
      text: x.headline || (x.dish + ' 这条也值得看'),
    }));
    let side = '';
    if (wallLines.length) side += L.wall(wallLines);
    if (related.length) {
      side += sect('跟这口有关的还有', null) + '<div class="list">' + related.slice(0, 4).map((x) => L.rvCard(x, { noShop: false })).join('') + '</div>';
    }
    // PC 上「正文 | 侧栏（毒舌墙 + 相关）」并排；移动端顺序与原来完全一致：正文在前。
    const body = '<div class="rev-wrap"><div class="rev-main">' + main + '</div>' +
      (side ? '<aside class="rev-side">' + side + '</aside>' : '') + '</div>' +
      foot({ site: await L.boot().then((b) => b.site || {}) });

    const addr = r.shop ? (r.shop.name + (r.shop.district ? ' ' + r.shop.district : '')) : r.dish;
    const dock = '<div class="dock3">' +
      (r.shop
        ? '<a class="go" href="https://uri.amap.com/search?keyword=' + encodeURIComponent(addr) + '" target="_blank" rel="noopener">导航去恰</a>'
        : '<a class="go" href="/yushanfang" data-track>回御膳房灶台</a>') +
      '<button class="share" type="button">分享卡片</button></div>';

    return { title: r.dish, sub: isYu ? '御膳房 · 她亲手做的' : (r.shop ? r.shop.name : '单菜点评'), back: true, tab: isYu ? 'yushanfang' : 'tandian', body: body, dock: dock, after: bindDock };
  }

  function bindDock(root) {
    const share = root.querySelector('.share');
    if (share) {
      share.addEventListener('click', async () => {
        const url = location.href;
        const title = document.title;
        try {
          if (navigator.share) { await navigator.share({ title: title, url: url }); return; }
          await navigator.clipboard.writeText(url);
          L.toast('链接已复制，去发给他');
        } catch (e) {
          L.toast('复制失败，手动复制地址栏吧');
        }
      });
    }
  }

  /* ============ 口味筛选 ============ */
  async function taste() {
    const d = await L.boot(true);
    const block = (title, list, cls) => sect(title, null) +
      (list.length ? '<div class="flt" style="flex-wrap:wrap;padding-bottom:4px">' + list.map((t) =>
        '<a class="' + (cls || '') + (t.count ? '' : '') + '" href="/rank?taste=' + encodeURIComponent(t.slug) + '" data-track>' +
        esc(t.name) + '<span style="opacity:.6"> ' + num(t.count) + '</span></a>').join('') + '</div>'
        : '<div class="loadmore">还没建标签</div>');
    let body = '<div class="detail"><p class="muted" style="font-size:12.5px;font-weight:700">想吃哪一口，点一下就是筛过的榜。标签可以在后台增删。</p></div>' +
      '<div class="taste-wrap">' +
        '<div class="taste-col">' + block('口味', d.tastes || []) + '</div>' +
        '<div class="taste-col">' + block('场景', d.scenes || []) + '</div>' +
      '</div>';
    body += '<div class="foot"><b>没有你要的那口？</b><p>口味标签是后台加的，缺什么就在后台补一个，点评挂上去就生效。</p>' +
      '<div class="links"><a href="/rank" data-track>直接看总榜</a></div></div>';
    return { title: '口味筛选', sub: '按这一口找店', tab: 'tandian', body: body };
  }

  /* ============ 关于 / 评级标准 ============ */
  async function about() {
    const d = await L.boot(true);
    const s = d.site || {}, c = d.counters || {};
    let body = '<div class="about-ip"><img src="' + L.img(s.ip_avatar) + '" alt="' + esc(s.ip_name) + '">' +
      '<div><h2>' + esc(s.ip_name || '辣条妹') + '</h2><div class="hd">' + esc(s.ip_handle || '') + ' · ' + esc(s.ip_city || '') + '</div>' +
      '<div class="hb-line">10年老杭州外地人 · 只做杭州美食文化</div>' +
      '<div class="hd">粉丝 ' + esc(s.fans_display || '—') + '</div></div></div>' +
      '<div class="one-thing"><b>这里只做一件事：</b>杭州美食。不跨城、不恰饭、不带节奏——10 年吃出来的榜，才敢让你照着吃。</div>' +
      '<div class="detail"><div class="say3"><div class="m">' + L.mascot({ mouth: 'smile' }) + '</div><div><small>条总的话</small><b>' + esc(s.ip_quote || '') + '</b></div></div>' +
      '<div class="body3">' + esc(s.ip_bio || '') + '</div></div>';
    body += sect('五档判定', null) + '<div class="tiers">' + (d.tiers || []).map((t) =>
      '<div class="tier"><div class="w vc t-' + esc(t.code) + '" style="width:52px;height:52px">' + esc(t.label) + '</div>' +
      '<div><h4>' + esc(t.name) + '</h4><p>' + esc(t.desc) + '</p></div></div>').join('') + '</div>';
    body += '<div class="counts" style="margin-top:14px">' +
      '<div><b>' + num(c.shops) + '</b><small>踩过的店</small></div>' +
      '<div><b>' + num(c.published) + '</b><small>条点评</small></div>' +
      '<div><b>' + num(c.views) + '</b><small>次翻牌子</small></div></div>';
    body += '<div class="foot"><b>' + esc(s.footer_note || '') + '</b><p>' + esc(s.seo_description || '') + '</p>' +
      '<div class="links">' + (s.douyin_url ? '<a href="' + esc(s.douyin_url) + '" target="_blank" rel="noopener">抖音</a>' : '') +
      (s.xhs_url ? '<a href="' + esc(s.xhs_url) + '" target="_blank" rel="noopener">小红书</a>' : '') +
      '</div></div>';
    return { title: '关于 · 评级标准', sub: '自己掏钱 · 吃完当天就写', tab: 'about', body: body };
  }

  /* ============ 搜索 ============ */
  async function search(q) {
    const kw = q.q || '';
    const d = await L.boot();
    let body = '<div class="searchbar"><input id="q" type="search" placeholder="菜名 / 店名 / 关键词" value="' + esc(kw) + '"><button id="qgo" type="button">搜</button></div>';
    if (!kw) {
      body += L.empty('搜点什么', '比如「面」「虾」「西湖」');
      return { title: '搜一搜', sub: '菜名 · 店名 · 正文', tab: 'tandian', body: body, after: bindSearch };
    }
    const [rev, shp] = await Promise.all([
      L.api.get('/api/reviews', { q: kw, kind: 'all', size: 20 }),
      L.api.get('/api/shops', { q: kw, size: 6 }),
    ]);
    if (shp.items.length) body += sect('店', null) + '<div class="list">' + shp.items.map(shopCard).join('') + '</div>';
    body += sect('点评', null) + (rev.items.length
      ? '<div class="list">' + rev.items.map((r) => L.rvCard(r)).join('') + '</div>'
      : L.empty('没有这道菜', '换个词试试'));
    return { title: '搜「' + kw + '」', sub: num(rev.total) + ' 条点评 · ' + num(shp.total) + ' 家店', tab: 'tandian', body: body, after: bindSearch };
  }

  /* ============ 404 ============ */
  async function notfound() {
    return { title: '这条不存在', sub: '404', body: L.empty('走错门了', '点底部「首页」重新找') };
  }

  return { home, tandian, yushanfang, rank, shops, shop, review, taste, about, search, notfound, foot, sect, link, shopCard };
})();
