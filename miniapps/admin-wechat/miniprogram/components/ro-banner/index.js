// 只读提示条：pending 身份在每个有写操作的页面顶部显示。
Component({
  properties: {
    // 外部传入的角色；为空时组件自己去本地会话读，省得每个页面都记得传。
    role: { type: String, value: '' },
    text: {
      type: String,
      value: '你的微信身份还在待审核，可以看不能改。需要权限请在「我的」里让主人放行。',
    },
  },
  data: { show: false },
  lifetimes: {
    attached() { this.refresh(); },
  },
  observers: {
    role() { this.refresh(); },
  },
  methods: {
    refresh() {
      const r = this.data.role || wx.getStorageSync('lm_wx_role') || '';
      this.setData({ show: r !== '' && r !== 'owner' && r !== 'admin' });
    },
  },
});
