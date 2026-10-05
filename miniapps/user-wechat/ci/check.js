// 纯本地结构检查：不联网、不需要 appid/密钥，用来在提交前抓低级错误。
// 用法：node ci/check.js
//
// 校验内容：
//   1. 所有 .json 可解析；app.json 引用的页面四件套齐全
//   2. tabBar 页面都在 pages 中注册
//   3. 每个 .js 能通过语法解析，且 require 的相对模块真实存在
//   4. WXML 标签闭合平衡（粗粒度，够用）
//   5. usingComponents 引用的组件路径存在
//   8. Component() 自定义方法必须写在 methods 里（顶层会被小程序静默丢弃）
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const problems = [];
const warn = (msg) => problems.push(msg);

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = walk(ROOT);
const rel = (p) => path.relative(ROOT, p);

// ---- 1. JSON 可解析 ----
const jsons = files.filter((f) => f.endsWith('.json'));
const parsed = {};
for (const f of jsons) {
  try { parsed[rel(f)] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { warn(`JSON 解析失败 ${rel(f)}: ${e.message}`); }
}

// ---- 2. 页面四件套 + tabBar 注册 ----
const app = parsed['app.json'];
if (!app) warn('缺少 app.json 或不可解析');
else {
  const pages = app.pages || [];
  if (!pages.length) warn('app.json 里没有 pages');
  for (const p of pages) {
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      if (!fs.existsSync(path.join(ROOT, `${p}.${ext}`))) warn(`页面文件缺失: ${p}.${ext}`);
    }
  }
  (app.tabBar && app.tabBar.list ? app.tabBar.list : []).forEach((t) => {
    if (!pages.includes(t.pagePath)) warn(`tabBar 页面未注册到 pages: ${t.pagePath}`);
  });
  // 入口页是第一项（冷启动首页）。v11 起 C 位「辣条妹」(pages/ai) 即冷启动首页，
  // 之前是 index；两种都算设计内，其余入口页才提醒。
  if (pages[0] !== 'pages/index/index' && pages[0] !== 'pages/ai/ai') {
    warn(`提示：入口页是 ${pages[0]}（第 0 项即冷启动首页）`);
  }
}

// ---- 3. JS 语法 + 相对依赖存在 ----
for (const f of files.filter((x) => x.endsWith('.js'))) {
  const code = fs.readFileSync(f, 'utf8');
  try {
    parser.parse(code, { sourceType: 'module', plugins: ['objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'] });
  } catch (e) { warn(`JS 语法错误 ${rel(f)}: ${e.message}`); }
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    const target = path.resolve(path.dirname(f), m[1]);
    const ok = ['', '.js', '/index.js', '.json'].some((suf) => fs.existsSync(target + suf) && fs.statSync(target + suf).isFile());
    if (!ok) warn(`require 目标不存在 ${rel(f)} → ${m[1]}`);
  }
}

// ---- 4. WXML 标签闭合（粗粒度） ----
const VOID_TAGS = new Set(['image', 'input', 'import', 'include', 'wxs', 'icon', 'br']);
for (const f of files.filter((x) => x.endsWith('.wxml'))) {
  const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g;
  let m;
  while ((m = re.exec(src))) {
    const [full, tag, attrs] = m;
    const isClose = full.startsWith('</');
    const selfClose = /\/>$/.test(full) || VOID_TAGS.has(tag);
    if (isClose) {
      if (!stack.length || stack[stack.length - 1] !== tag) {
        warn(`WXML 标签不匹配 ${rel(f)}: 期望 </${stack[stack.length - 1] || '∅'}> 实得 </${tag}>`);
        break;
      }
      stack.pop();
    } else if (!selfClose) {
      stack.push(tag);
    }
    void attrs;
  }
  if (stack.length) warn(`WXML 未闭合标签 ${rel(f)}: ${stack.join(' > ')}`);
}


// ---- 4b. WXML 表达式里不许出现转义符/反引号 ----
// 踩过的坑：data-text="{{a + '\n' + b}}" 本地预览没事，微信上传直接 -80054
// （Bad attr `data-text` ... error at token `$`），只能在服务器上看日志才知道。
// WXML 的表达式解析器不认 JS 字符串转义与模板串，要拼字符串请在 js 里算好。
for (const f of files.filter((x) => x.endsWith('.wxml'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [, expr] of line.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      if (/\\[nt'"`\\]/.test(expr)) warn(`WXML 表达式含转义符 ${rel(f)}:${i + 1}（请在 js 里拼好再绑）: ${expr.trim().slice(0, 60)}`);
      else if (expr.includes('`')) warn(`WXML 表达式含反引号 ${rel(f)}:${i + 1}（微信编译器不认）: ${expr.trim().slice(0, 60)}`);
    }
  });
}

// ---- 5. usingComponents 路径存在 ----
for (const [name, obj] of Object.entries(parsed)) {
  if (!obj || typeof obj !== 'object') continue;
  const uc = obj.usingComponents || (obj.window && obj.window.usingComponents);
  if (!uc) continue;
  const base = path.dirname(path.join(ROOT, name));
  for (const [comp, p] of Object.entries(uc)) {
    const target = p.startsWith('/') ? path.join(ROOT, p) : path.join(base, p);
    const ok = ['', '.js', '/index.js'].some((suf) => fs.existsSync(target + suf) && fs.statSync(target + suf).isFile());
    if (!ok) warn(`组件不存在 ${name} 里的 "${comp}" → ${p}`);
  }
}

// ---- 6. WXSS 花括号配平 + 无孤儿声明 + 无非法字符 ----
// 踩过的两个坑：
//   a) 删样式时只删了跳行规则的第一行，剩下半截语句以 `;` 开头
//   b) 文件尾混进了非 CSS 文本
// 两者本地不报错，但微信上传直接拒（-80056），所以这里硬性拦下。
for (const f of files.filter((x) => x.endsWith('.wxss'))) {
  const raw = fs.readFileSync(f, 'utf8');
  // WXSS 里永远不会出现 `<`（选择器、属性、@规则都不用它）。
  raw.split('\n').forEach((ln, i) => {
    if (ln.includes('<')) warn(`WXSS 含非法字符 < ${rel(f)}:${i + 1}  →  ${ln.trim().slice(0, 60)}`);
  });
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, line = 1, bad = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { line++; continue; }
    if (ch === '{') {
      depth++;
      // 块开头之前不应出现悬空的属性声明（孤儿片段的典型特征）。
      const before = src.slice(Math.max(0, i - 120), i);
      const lastBrace = Math.max(before.lastIndexOf('}'), before.lastIndexOf('{'));
      const tail = before.slice(lastBrace + 1).trim();
      if (/;$/.test(tail)) { warn(`WXSS 孤儿声明 ${rel(f)}:${line} 之前的内容未包在规则块里`); bad = true; }
    } else if (ch === '}') {
      depth--;
      if (depth < 0) { warn(`WXSS 多余右花括号 ${rel(f)}:${line}`); bad = true; depth = 0; }
    }
  }
  if (depth !== 0 && !bad) warn(`WXSS 未闭合花括号 ${rel(f)}（差 ${depth} 个）`);
}

// ---- 8. Component 方法必须收进 methods ----
// 小程序自定义组件只认 properties/data/lifetimes/pageLifetimes/observers/methods 等保留字段，
// 方法直接挂在 Component({}) 顶层不报错，但运行时全是 undefined —— 表现为整页空白。
const COMP_RESERVED = new Set(['properties', 'data', 'lifetimes', 'pageLifetimes', 'observers',
  'methods', 'behaviors', 'externalClasses', 'options', 'relations', 'definitionFilter', 'mixins']);
for (const f of files.filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/(^|[\s=({])Component\s*\(/.test(src)) continue;
  const start = src.indexOf('Component(');
  if (start < 0) continue;
  const body = src.slice(src.indexOf('{', start) + 1);
  // 只扫顶层：depth 回到 0 就是 Component({}) 结束了。
  let depth = 0, line = 1, i = 0;
  const topKeys = [];
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) break; // Component({ ... }) 的外层花括号结束
      depth--; i++; continue;
    }
    if (depth === 0) {
      const m = /^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s)*([A-Za-z_$][\w$]*)\s*[:(]/.exec(body.slice(i));
      if (m) {
        if (!COMP_RESERVED.has(m[1])) topKeys.push({ key: m[1], line });
        i += m[0].length; continue;
      }
    }
    i++;
  }
  if (topKeys.length) {
    warn(`Component 顶层方法不会被注册 ${rel(f)}: ${topKeys.map((t) => t.key + '@' + t.line).join(', ')} —— 请移进 methods {}（否则运行时是 undefined，页面直接空白）`);
  }
}

// ---- 7. 全文件串入污染检查：源码里不该出现工具标签残留 ----
for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/.test(f)) continue;
  const s = fs.readFileSync(f, 'utf8');
  if (s.includes('</content>') || s.includes('<content>')) {
    warn(`文件混入了工具输出标签残留 ${rel(f)}，必须删掉`);
  }
}

if (problems.length) {
  console.log(`✗ 发现 ${problems.length} 个问题:\n`);
  problems.forEach((p) => console.log('  -', p));
  process.exit(1);
}
console.log(`✓ 本地结构检查通过（${files.length} 个文件，${(app && app.pages || []).length} 个页面）`);
