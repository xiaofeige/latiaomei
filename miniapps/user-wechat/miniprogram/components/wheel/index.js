// 首页「今天吃啥子」转盘，对齐 web 站 core.js 的 wheel()：
// canvas 2d 画盘（「点心蒸笼」暖色扇区、汉字标签沿半径正立摆放），CSS transform 转 5~6 圈，
// 4.2s 减速后出「一字判决」结果卡。segs=[{label, sub, slug, tier}]，3~12 个扇区。
// 盘色：低饱和暖色系（蜜/杏/桃/奶茶/鼠尾草），黑字对比度全 AA；换色只动这里
const PAL = ['#FFD966', '#FFB37A', '#F5B8C4', '#FFE9A8', '#A9DED5', '#D9E8C0'];
// 判决字方块配色，与 app.wxss .vc.t-* 同源
const VC_BG = { hang: '#FFD966', dingji: '#F5B8C4', renshang: '#D9E8C0', npc: '#A9DED5', la: '#141414' };
const SPIN_MS = 4200;   // 转动时长
const LAND_MS = 4380;   // 停稳出结果的时刻

Component({
  properties: {
    segs: { type: Array, value: [], observer() { this._reset(); } },
    tiers: { type: Array, value: [] }, // 档位元数据（code→label），拿 bootstrap 下发的
  },
  data: {
    angle: 0, dur: 0, busy: false,
    res: null, resLabel: '', resColor: '#8a8478', bad: false, pop: false,
  },
  lifetimes: {
    detached() { clearTimeout(this.timer); },
    ready() { this._initCanvas(); }, // 首帧渲染后再兑一次，防 observer 比节点早到
  },
  methods: {
    // 换盘（探店/御膳房切换、数据刷新）：角度清零、结果收起、重画
    _reset() {
      this.cur = 0;
      clearTimeout(this.timer);
      this.setData({ angle: 0, dur: 0, busy: false, res: null, pop: false });
      wx.nextTick(() => this._initCanvas());
    },

    _initCanvas() {
      const q = (this.createSelectorQuery && this.createSelectorQuery()) || null;
      if (!q) return;
      q.select('#wc').fields({ node: true, size: true }).exec((r) => {
        const hit = r && r[0];
        if (!hit || !hit.node) return; // 扇区不足 3 个时 canvas 根本没渲染
        const { node, width, height } = hit;
        const wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = wi.pixelRatio || 2;
        node.width = width * dpr;
        node.height = height * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);
        this.ctx = ctx; this.cw = width; this.ch = height;
        this._draw();
      });
    },

    _draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      const segs = this.data.segs || [];
      const n = segs.length;
      ctx.clearRect(0, 0, this.cw, this.ch);
      if (n < 3) return;
      const cx = this.cw / 2, cy = this.ch / 2, R = Math.min(cx, cy) - 3;
      const step = 360 / n, scale = R / 92;
      const fs = (n <= 8 ? 10.5 : n <= 10 ? 9.5 : 9) * scale * 1.1;
      const maxLen = n <= 8 ? 5 : n <= 10 ? 4 : 3;
      segs.forEach((s, i) => {
        const a0 = ((i * step - 90) * Math.PI) / 180;
        const a1 = (((i + 1) * step - 90) * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = PAL[i % PAL.length];
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        // 标签沿扇区中线摆放但始终正立（汉字转盘不能出现下半圈倒字），停稳时才跟着盘转
        const am = (((i * step + step / 2) - 90) * Math.PI) / 180;
        let lb = String(s.label || '');
        if (lb.length > maxLen) lb = lb.slice(0, maxLen - 1) + '…';
        ctx.fillStyle = '#111';
        ctx.font = '900 ' + fs.toFixed(1) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lb, cx + Math.cos(am) * R * 0.62, cy + Math.sin(am) * R * 0.62);
      });
      // 外圈黑环
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#111';
      ctx.stroke();
    },

    // 中心钮：随机落点（扇区中心 ±35% 抖动，别总停正中间），转 5~6 圈
    spin() {
      const segs = this.data.segs || [];
      const n = segs.length;
      if (this.data.busy || n < 3) return;
      const step = 360 / n;
      const j = Math.floor(Math.random() * n);
      const jitter = (Math.random() - 0.5) * step * 0.7;
      // 指针在底部（角度 +90），让扇区 j 中线转过去：mid - 90 + angle = 90 → angle = 180 - mid
      const target = (((180 - (j * step + step / 2) + jitter) % 360) + 360) % 360;
      const cur = this.cur || 0;
      const norm = ((cur % 360) + 360) % 360;
      this.cur = cur + (((target - norm) + 360) % 360) + 360 * (5 + Math.floor(Math.random() * 2));
      this.setData({ busy: true, res: null });
      this.setData({ angle: this.cur, dur: SPIN_MS });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._land(segs[j]), LAND_MS);
    },

    _land(s) {
      this.setData({ busy: false });
      try { wx.vibrateShort({ type: 'medium', fail() {} }); } catch (e) { /* 部分机型没有短振动 */ }
      const meta = (this.data.tiers || []).find((t) => t.code === (s.tier || 'npc')) || {};
      this.setData({
        res: s,
        resLabel: meta.label || '尝',
        resColor: VC_BG[s.tier] || '#8a8478',
        bad: s.tier === 'la',
        pop: true, // 停稳即宣判：弹窗提醒，点主按钮可跳转
      });
      this.triggerEvent('result', { seg: s });
    },

    /* ---------------- 宣判弹窗 ---------------- */
    closePop() { this.setData({ pop: false }); },
    noop() { /* 挡住穿透点击 */ },
    pickFromPop() {
      this.setData({ pop: false });
      this.go();
    },
    againPop() {
      this.setData({ pop: false });
      // 关窗后直接续转，一气呵成
      wx.nextTick(() => this.spin());
    },

    go() {
      if (this.data.res) this.triggerEvent('pick', { seg: this.data.res });
    },
  },
});
