// 点评编辑/新建。字段与服务端 reviewBody 一一对应。
// 关键：保存是整行更新，编辑时必须把 slug 等隐藏字段带回去，否则 URL 会变。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const guard = require('../../utils/guard');

const KINDS = [
  { code: 'tandian', name: '探店（出去吃的）' },
  { code: 'yushanfang', name: '私厨（自家做的，原御膳房）' },
];

// 五档从强到弱，与服务端 tierMetas / utils/format.TIERS 对齐。
const TIER_CODES = ['hang', 'dingji', 'renshang', 'npc', 'la'];

const emptyForm = () => ({
  id: 0, slug: '', kind: 'tandian', shop_id: 0, dish: '', tier: 'dingji', score: 4.5,
  spicy: 0, price: 0, headline: '', body: '', order_tip: '', revisit: 0, visit_date: '',
  cover: '', images: [], featured: false, wheel: true, rank_no: 0, status: 'draft', tastes: [],
});

Page({
  data: {
    form: emptyForm(),
    isEdit: false,
    saving: false,
    tiers: TIER_CODES.map((code) => ({ code, label: fmt.tier(code).label, color: fmt.tier(code).color })),
    kindNames: KINDS.map((k) => k.name),
    kindIndex: 0,
    shops: [],
    shopNames: [],
    shopIndex: -1,
    tastes: [],
    coverUrl: '',
    fullImages: [],
  },

  onLoad(query) {
    if (!guard.requireWrite('/pages/reviews/reviews')) return;
    this.loadRefs().then(() => {
      if (query && query.id) {
        this.setData({ isEdit: true });
        wx.setNavigationBarTitle({ title: '编辑内容' });
        api.getReview(query.id).then((rv) => this.fill(rv)).catch(() => {});
      } else {
        wx.setNavigationBarTitle({ title: '录入内容' });
        // 从列表栏目 tab 带进来的默认主题（探店/御膳房）。
        if (query && query.kind && KINDS.some((k) => k.code === query.kind)) {
          const ki = KINDS.findIndex((k) => k.code === query.kind);
          this.setData({ 'form.kind': query.kind, kindIndex: ki });
        }
      }
    });
  },

  // 店铺与标签是表单的选项来源，先拉齐。
  loadRefs() {
    return Promise.all([
      api.listShops({ size: 200, sort: 'name' }).catch(() => null),
      api.listTastes('').catch(() => []),
    ]).then(([shopPage, tastes]) => {
      const shops = (shopPage && shopPage.items) || [];
      // 第一个位置给"不关联"，避免必须选一家店。
      const shopNames = ['（不关联店铺）'].concat(shops.map((s) => `${s.name} · ${s.city || '未填城市'}`));
      this.setData({
        shops,
        shopNames,
        tastes: (tastes || []).map((t) => ({ ...t, _on: false })),
      });
    });
  },

  // 用后端返回的完整点评回填表单。
  fill(rv) {
    const form = {
      ...emptyForm(),
      id: rv.id,
      slug: rv.slug,
      kind: rv.kind || 'tandian',
      shop_id: rv.shop_id || 0,
      dish: rv.dish || '',
      tier: rv.tier || 'npc',
      score: rv.score,
      spicy: rv.spicy,
      price: rv.price,
      headline: rv.headline || '',
      body: rv.body || '',
      order_tip: rv.order_tip || '',
      revisit: rv.revisit,
      visit_date: rv.visit_date || '',
      cover: rv.cover || '',
      images: rv.images || [],
      featured: !!rv.featured,
      wheel: rv.wheel !== false,
      rank_no: rv.rank_no || 0,
      status: rv.status || 'draft',
      tastes: (rv.tastes || []).map((t) => t.slug),
    };
    const ki = KINDS.findIndex((k) => k.code === form.kind);
    const si = this.data.shops.findIndex((s) => s.id === form.shop_id);
    const tastes = this.data.tastes.map((t) => ({ ...t, _on: form.tastes.indexOf(t.slug) >= 0 }));
    this.setData({
      form,
      kindIndex: ki < 0 ? 0 : ki,
      shopIndex: si < 0 ? -1 : si + 1, // +1 因为第 0 项是"不关联"
      tastes,
      coverUrl: fmt.fullUrl(form.cover),
      fullImages: (form.images || []).map(fmt.fullUrl),
    });
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value });
  },
  onTier(e) { this.setData({ 'form.tier': e.currentTarget.dataset.code }); },
  onKind(e) {
    const i = Number(e.detail.value);
    this.setData({ kindIndex: i, 'form.kind': KINDS[i].code });
  },
  onShop(e) {
    const i = Number(e.detail.value);
    const shopId = i <= 0 ? 0 : this.data.shops[i - 1].id;
    this.setData({ shopIndex: i, 'form.shop_id': shopId });
  },
  onDate(e) { this.setData({ 'form.visit_date': e.detail.value }); },
  onFeatured(e) { this.setData({ 'form.featured': e.detail.value }); },
  onWheel(e) { this.setData({ 'form.wheel': e.detail.value }); },
  onStatusSet(e) { this.setData({ 'form.status': e.currentTarget.dataset.v }); },
  onTaste(e) {
    const i = e.currentTarget.dataset.i;
    const key = `tastes[${i}]._on`;
    this.setData({ [key]: !this.data.tastes[i]._on });
  },

  // ---- 图片 ----
  pickCover() { this.chooseOne((path) => this.applyUpload(path, 'cover')); },
  pickImg() {
    const remain = 9 - this.data.form.images.length;
    wx.chooseMedia({
      count: remain, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        const tasks = res.tempFiles.map((f) => this.applyUploadSilent(f.tempFilePath));
        Promise.all(tasks).then((paths) => {
          const images = this.data.form.images.concat(paths.filter(Boolean));
          this.setData({ 'form.images': images, fullImages: images.map(fmt.fullUrl) });
        });
      },
    });
  },
  chooseOne(cb) {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => cb(res.tempFiles[0].tempFilePath),
    });
  },
  applyUpload(path, field) {
    api.upload(path).then((d) => {
      this.setData({ [`form.${field}`]: d.path, coverUrl: fmt.fullUrl(d.path) });
      wx.showToast({ title: d.saved_note ? '已压缩上传' : '已上传', icon: 'success' });
    }).catch((err) => wx.showToast({ title: err.message || '上传失败', icon: 'none' }));
  },
  applyUploadSilent(path) {
    return api.upload(path).then((d) => d.path).catch(() => '');
  },
  delCover() { this.setData({ 'form.cover': '', coverUrl: '' }); },
  delImg(e) {
    const images = this.data.form.images.slice();
    images.splice(e.currentTarget.dataset.i, 1);
    this.setData({ 'form.images': images, fullImages: images.map(fmt.fullUrl) });
  },
  previewCover() { if (this.data.coverUrl) wx.previewImage({ urls: [this.data.coverUrl] }); },
  previewImg(e) { wx.previewImage({ current: this.data.fullImages[e.currentTarget.dataset.i], urls: this.data.fullImages }); },

  // ---- 保存 ----
  save() {
    const f = this.data.form;
    if (!String(f.dish).trim()) { wx.showToast({ title: '菜名不能为空', icon: 'none' }); return; }

    const tasteSlugs = this.data.tastes.filter((t) => t._on).map((t) => t.slug);
    const body = {
      id: f.id || 0,
      slug: f.slug || '',
      kind: f.kind,
      shop_id: Number(f.shop_id) || 0,
      dish: String(f.dish).trim(),
      tier: f.tier,
      score: Number(f.score) || 0,
      spicy: Number(f.spicy) || 0,
      price: Number(f.price) || 0,
      headline: f.headline || '',
      body: f.body || '',
      order_tip: f.order_tip || '',
      revisit: Number(f.revisit) || 0,
      visit_date: f.visit_date || '',
      cover: f.cover || '',
      images: f.images || [],
      featured: !!f.featured,
      wheel: f.wheel !== false,
      rank_no: Number(f.rank_no) || 0,
      status: f.status,
      tastes: tasteSlugs,
    };

    this.setData({ saving: true });
    const req = f.id ? api.updateReview(f.id, body) : api.createReview(body);
    req
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => {
          // 回列表；列表 onShow 会自动刷新。
          const pages = getCurrentPages();
          if (pages.length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/reviews/reviews' });
        }, 500);
      })
      .catch(() => {})
      .then(() => this.setData({ saving: false }));
  },

  cancel() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/reviews/reviews' });
  },
});
