'use strict';
// pub_weibo：已发布点评 → 微博自动分发。文案/凭证/选择器全在 ../publishers.json，
// 引擎见 lib/social.js（凭证没配时降级为落盘"发布包"，不阻塞流水线）。
module.exports = { type: 'weibo', run: (t) => require('../lib/social').publish(t, 'weibo') };
