// 自定义 tabBar：恰啥 / 榜单 / 【C位：辣条妹（AI 对话，全站招牌）】/ 许愿 / 本人。
// 「辣条妹」这个名字只属于 C 位 AI Tab，个人页叫「本人」，不抢戏。
// 左两组两 Tab + 右两组两 Tab 对称。每个 tab 页 onShow 里调 getTabBar().setActive(key) 点亮自己。
Component({
  data: {
    active: 'ai',
    tabs: [
      { k: 'index', path: '/pages/index/index', ic: '🎡', t: '恰啥', side: 'l' },
      { k: 'list', path: '/pages/list/list', ic: '🌶', t: '榜单', side: 'l' },
      { k: 'wish', path: '/pages/wish/wish', ic: '🙏', t: '许愿墙', side: 'r' },
      { k: 'my', path: '/pages/my/my', ic: '👅', t: '本人', side: 'r' },
    ],
  },
  methods: {
    setActive(k) {
      if (this.data.active !== k) this.setData({ active: k });
    },
    go(e) {
      const p = e.currentTarget.dataset.p;
      const k = e.currentTarget.dataset.k;
      if (this.data.active === k) return;
      wx.switchTab({ url: p });
    },
    goAi() {
      if (this.data.active === 'ai') {
        // 已经在 AI 页：点头像回到对话顶部，顺手清个输入草稿不做
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });
        return;
      }
      wx.switchTab({ url: '/pages/ai/ai' });
    },
  },
});
