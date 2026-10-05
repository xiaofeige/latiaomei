'use strict';
// wxpush：小程序订阅消息推送。微信一次订阅只能发一条，配额由服务端记账。
// 需要：MP 用户端 appid/secret + 后台 settings 里配好的 wx_sub_tpl_id，缺一直接 skip。
const api = require('../lib/api');
const { CFG } = require('../lib/env');

let tokenCache = { tok: '', exp: 0 };
async function wxToken() {
  if (tokenCache.tok && Date.now() < tokenCache.exp) return tokenCache.tok;
  const u = new URLSearchParams({ grant_type: 'client_credential', appid: CFG.wxmini.appid, secret: CFG.wxmini.secret });
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/token?' + u, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (!j.access_token) throw new Error('小程序 token 失败：' + JSON.stringify(j).slice(0, 200));
  tokenCache = { tok: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tokenCache.tok;
}

async function runWxPush(task) {
  if (!task.review_id) return { status: 'skipped', note: '推送任务未绑定内容' };
  if (!CFG.wxmini.appid || !CFG.wxmini.secret) return { status: 'skipped', note: '未配置小程序用户端凭证（MP_APPID/MP_SECRET）' };
  const { settings } = await api.settings();
  const tpl = settings.wx_sub_tpl_id;
  if (!tpl) return { status: 'skipped', note: '后台未配置订阅消息模板 ID（wx_sub_tpl_id）' };

  const { review: rv, site } = await api.getReview(task.review_id);
  const subs = (await api.subscribers('wxmini', 200)).subscribers || [];
  if (!subs.length) return { status: 'skipped', note: '没有可用推送配额（用户未订阅或已用完）' };

  const tok = await wxToken();
  const page = `pages/detail/detail?id=${rv.id}`; // 用户端小程序落地页，路径变化改这里
  let sent = 0, fail = 0;
  for (const s of subs) {
    // 发送失败也核销配额：微信侧一次授权只能发一条，43101 这类错误重试无意义。
    try {
      const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${tok}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: s.openid, template_id: tpl, page,
          data: {
            thing1: { value: (rv.dish || '').slice(0, 20) },
            thing2: { value: (rv.headline || '辣条妹更新啦').slice(0, 20) },
            time3: { value: new Date().toLocaleString('zh-CN', { hour12: false }) },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await res.json();
      if (j.errcode === 0) sent++; else fail++;
    } catch { fail++; }
    await api.consume('wxmini', s.openid).catch(() => {});
    await new Promise((r) => setTimeout(r, 60)); // 别把手动接口打出流控
  }
  return { status: 'done', result: { review_id: rv.id, targets: subs.length, sent, fail } };
}

module.exports = { type: 'wxpush', run: runWxPush };
