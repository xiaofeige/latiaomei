'use strict';
// LLM 调用：OpenAI 兼容 /chat/completions。json 模式自动剥 ``` 围栏并解析。
// 429/5xx/配额类错误自动重试 3 次（指数退避），其余直接抛。
const { CFG } = require('./env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chatOnce(messages, { json = false, temperature = 0.8, maxTokens = 2000, model = '' } = {}) {
  const res = await fetch(CFG.llmBase.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + CFG.llmKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || CFG.llmModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.retryable = res.status === 429 || res.status >= 500 || /quota|throttl|timed?\s*out/i.test(text);
    throw err;
  }
  const j = JSON.parse(text);
  return j.choices?.[0]?.message?.content || '';
}

async function chat(messages, opts = {}) {
  if (!CFG.llmKey) throw new Error('LLM_API_KEY 未配置');
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await chatOnce(messages, opts);
      if (!opts.json) return raw;
      const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      const start = cleaned.search(/[[{]/);
      return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned);
    } catch (e) {
      last = e;
      if (!e.retryable && !(e instanceof SyntaxError)) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

// 辣条妹统一人设。所有 job 的 system 设定以此为基底，禁止各 job 自行魔改口吻。
const PERSONA = `你是"辣条妹的御膳房"内容流水线的撰稿AI。辣条妹人设：杭州最懂吃的本地老饕，
十年吃遍杭州、只恰真的（只讲真话）。口吻：市井、直接、毒舌但公道，会用杭州话点缀（"儿"化音、"落胃"、"交关"），
绝不写营销号腔、绝不堆形容词、绝不承诺"最好吃"这类绝对化用语（广告法）。
输出用于内容审核流程，所有店铺/菜品信息必须基于给定素材，不得编造具体店名、价格、地址。`;

module.exports = { chat, PERSONA };
