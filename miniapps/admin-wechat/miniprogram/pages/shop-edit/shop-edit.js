// 店铺编辑/新建。字段严格对齐 store.Shop 的 JSON tag：
// 后端 decode 用了 DisallowUnknownFields，多传未知字段会 400。
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const guard = require('../../utils/guard');

const empty = () => ({
  id: 0, slug: '', name: '', city: '', district: '', address: '', cuisine: '',
  avg_price: 0, hours: '', douyin_url: '', xhs_url: '', cover: '', note: '',
  lat: 0, lng: 0,
});

Page({
  data: { form: empty(), isEdit: false, saving: false, coverUrl: '' },

  onLoad(query) {
    if (!guard.requireWrite('/pages/shops/shops')) return;
    if (!query || !query.id) { wx.setNavigationBarTitle({ title: '新建店铺' }); return; }
    this.setData({ isEdit: true });
    wx.setNavigationBarTitle({ title: '编辑店铺' });

    const cached = wx.getStorageSync('latiaomei_editing_shop');
    if (cached && String(cached.id) === String(query.id)) { this.fill(cached); return; }
    // 缓存没命中就回列表里找一次。
    api.listShops({ size: 200, sort: 'new' })
      .then((d) => {
        const hit = (d.items || []).filter((s) => String(s.id) === String(query.id))[0];
        if (hit) this.fill(hit);
      })
      .catch(() => {});
  },

  fill(sh) {
    const form = {
      ...empty(),
      id: sh.id, slug: sh.slug || '', name: sh.name || '', city: sh.city || '',
      district: sh.district || '', address: sh.address || '', cuisine: sh.cuisine || '',
      avg_price: sh.avg_price || 0, hours: sh.hours || '',
      douyin_url: sh.douyin_url || '', xhs_url: sh.xhs_url || '',
      cover: sh.cover || '', note: sh.note || '',
      lat: sh.lat || 0, lng: sh.lng || 0,
    };
    this.setData({ form, coverUrl: fmt.fullUrl(form.cover) });
  },

  onInput(e) { this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value }); },

  pickCover() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'],
      success: (res) => {
        api.upload(res.tempFiles[0].tempFilePath).then((d) => {
          this.setData({ 'form.cover': d.path, coverUrl: fmt.fullUrl(d.path) });
          wx.showToast({ title: '已上传', icon: 'success' });
        }).catch((err) => wx.showToast({ title: err.message || '上传失败', icon: 'none' }));
      },
    });
  },
  delCover() { this.setData({ 'form.cover': '', coverUrl: '' }); },

  // 地图选点（GCJ-02）：标了坐标的店才能进对客转盘的「附近」盘；地址没填时顺手带回来
  pickPoint() {
    wx.chooseLocation({
      success: (res) => {
        const patch = { 'form.lat': res.latitude, 'form.lng': res.longitude };
        if (!this.data.form.address && (res.address || res.name)) {
          patch['form.address'] = (res.address || '') + (res.name || '');
        }
        this.setData(patch);
        wx.showToast({ title: '位置已标', icon: 'success' });
      },
      fail: (e) => {
        if (e && /auth|deny/i.test(e.errMsg || '')) {
          wx.showToast({ title: '没给定位权限，标不了点', icon: 'none' });
        }
      },
    });
  },
  clearPoint() { this.setData({ 'form.lat': 0, 'form.lng': 0 }); },

  save() {
    const f = this.data.form;
    if (!String(f.name).trim()) { wx.showToast({ title: '店名不能为空', icon: 'none' }); return; }
    const body = {
      id: f.id || 0,
      slug: f.slug || '',
      name: String(f.name).trim(),
      city: f.city || '', district: f.district || '', address: f.address || '',
      cuisine: f.cuisine || '', avg_price: Number(f.avg_price) || 0,
      hours: f.hours || '', douyin_url: f.douyin_url || '', xhs_url: f.xhs_url || '',
      cover: f.cover || '', note: f.note || '',
      lat: Number(f.lat) || 0, lng: Number(f.lng) || 0,
    };
    this.setData({ saving: true });
    api.saveShop(body)
      .then(() => {
        wx.removeStorageSync('latiaomei_editing_shop');
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages.length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/shops/shops' });
        }, 500);
      })
      .catch(() => {})
      .then(() => this.setData({ saving: false }));
  },

  cancel() {
    wx.removeStorageSync('latiaomei_editing_shop');
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/shops/shops' });
  },
});
