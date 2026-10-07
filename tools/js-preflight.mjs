// 机械预检（无需 macOS / 无需浏览器）：**JS 侧的"调用了不存在的东西"扫描**。
//
// 为什么要单独做这个：2026-09-30 与 10-01 两天里，同一类 bug 出现了两次 ——
//   · `app.js` 调用 `refreshAlarmStatus()` 却**没导入** → 启动横幅「启动失败」
//   · `app.js` 写了 `scheduleAlarmsSoon()` —— **那个函数根本不存在** → 点一下就弹错
// 两次都是"静态读代码看不出来、只有运行时走到那一行才炸"。
// iOS 侧早就有 `tools/ios-bundle-check.mjs` 这种机械预检（它今天真的挡住过问题），
// JS 侧一直没有。这个脚本补上。
//
// 它查三件事（**只报"几乎不可能是误报"的**，宁可漏报也不制造噪音）：
//   ① 调用了**本项目里没有定义、也没导入**的名字（白名单 = 浏览器/语言内置）
//   ② 从本项目模块**导入了但整个文件一次都没用**的名字（死导入；往往是改名后的残留）
//   ③ `import { X } from './y.js'` 里 **y.js 并没有导出 X**（跨模块对账）
//
// 用法：node tools/js-preflight.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/** 要扫的目录（**只扫我们自己的源码**，不碰 build/ node_modules/ 生成物） */
const SCAN_DIRS = ['web', 'core', 'server', 'android/app/src/main/assets'];
/** 要扫的扩展名 */
const EXT = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'build' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
if (VERBOSE) console.log(`扫描 ${files.length} 个文件`);

/** 去掉注释、字符串**和正则字面量**（否则注释/正则里的词会被当成代码用） */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  // ⚠️ 判断一个 `/` 是"除法"还是"正则开始"：看它前面最后一个非空白字符。
  //    第一版没处理正则，于是 `/\b(api[_-]?key…)/` 里的 `b` 被当成"调用了一个叫 b 的函数"。
  let prevMeaningful = '';
  while (i < n) {
    const c = src[i]; const c2 = src.slice(i, i + 2);
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; i += 2; continue; }
      if (c2 === '/*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += ' '; i += 1; continue; }
      // 正则字面量：`/` 出现在"值的位置"，且这一行里还能找到配对的 `/`
      if (c === '/' && !/[\w$)\]}]/.test(prevMeaningful)) {
        const rest = src.slice(i + 1);
        const close = rest.search(/(?<!\\)\//);
        const newlineBefore = rest.search(/\n/);
        if (close >= 0 && (newlineBefore < 0 || close < newlineBefore)) {
          i += close + 2;
          out += ' ';
          prevMeaningful = '/';
          continue;
        }
      }
      out += c;
      if (!/\s/.test(c)) prevMeaningful = c;
      i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } i += 1; continue; }
    if (state === 'block') { if (c2 === '*/') { state = 'code'; i += 2; } else i += 1; continue; }
    if (c === '\\') { i += 2; continue; }
    // ⚠️⚠️ 模板字符串里的 `${ ... }` **是代码，不是字符串** ——
    //    第一版把整段模板都吞掉，于是"只在模板串里用过一次"的导入（`${hhmm(d)}`）全被
    //    误报成死导入（editor.js / core/alarms.js / core/recurrence.js 都是这么中招的）。
    //    这里遇到 `${` 就把括号内当代码处理（配对计数），其余部分仍然当字符串吞掉。
    if (state === '`' && c2 === '${') {
      out += ' ';
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const d = src[i];
        if (d === '{') depth += 1;
        else if (d === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
        if (d === '\n') out += '\n'; else out += d;
        i += 1;
      }
      continue;
    }
    if (c === state) { state = 'code'; i += 1; continue; }
    if (c === '\n') out += '\n';
    i += 1;
  }
  return out;
}

/**
 * 收集"解构参数"里的名字：`function f({ a, b: c }, [d]) {}` → a, c, d
 *
 * ⚠️ 为什么要单独做：第一版只认 `function name()` / `name = () =>` 这种简单参数，
 *    于是 `export function start({ getEvents, ... })` 里的 `getEvents`
 *    被当成"调用了一个不存在的函数"（假阳性）。真实项目里**解构参数到处都是**。
 */
function collectDestructuredParams(code) {
  const names = [];
  // 找每个 `(`，配对到对应的 `)`，若参数里有 `{...}` 就取出其中的标识符
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== '(') continue;
    let depth = 0; let end = -1;
    for (let j = i; j < code.length; j += 1) {
      if (code[j] === '(') depth += 1;
      else if (code[j] === ')') { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const params = code.slice(i + 1, end);
    // 参数里有 `{` 才可能是解构
    if (!/[{}]/.test(params)) continue;
    for (const m of params.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[:,}\]])/g)) names.push(m[1]);
    for (const m of params.matchAll(/\{\s*([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
  }
  return names;
}

/** 精确挖掉 `import ... from '...'` 语句（**按行范围**，不贪婪） */
function removeImportStatements(code) {
  const lines = code.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && /^\s*import\b/.test(line)) {
      // 单行就结束的情况：这一行里已经有 `from '...'`
      if (/\bfrom\s*['"]/.test(line) || /^\s*import\s*['"]/.test(line)) { out.push(''); continue; }
      skipping = true; out.push(''); continue;
    }
    if (skipping) {
      out.push('');
      if (/\bfrom\s*['"]/.test(line)) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 语言/浏览器内置（**不是**本项目的函数，出现这些名字不算问题） */
const GLOBALS = new Set([
  // 关键字（被正则误当函数名的）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'var',
  'let', 'const', 'async', 'await', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else',
  'try', 'finally', 'throw', 'case', 'default', 'break', 'continue', 'class', 'extends',
  'this', 'super', 'import', 'export', 'get', 'set', 'static',
  // 语言内置
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Error', 'TypeError',
  'RangeError', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Symbol', 'BigInt',
  'ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'DataView', 'Proxy', 'Reflect',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask', 'Intl', 'Function',
  // 宿主（浏览器 / 浏览器扩展 / 平台）
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'fetch', 'alert', 'confirm', 'prompt',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'Audio', 'Image', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
  'CustomEvent', 'Event', 'EventTarget', 'MessageChannel', 'Worker', 'Notification',
  'AudioContext', 'webkitAudioContext', 'localStorage', 'sessionStorage', 'indexedDB',
  'crypto', 'performance', 'navigator', 'screen', 'history', 'matchMedia', 'getComputedStyle',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'postMessage', 'atob', 'btoa',
  'importScripts', 'Deno', 'Bun',
  // 观察者 / 浏览器 API（第一版漏了它们，报了假阳性）
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
  'WebSocket', 'Worker', 'SharedWorker', 'ServiceWorker', 'AudioBuffer', 'GainNode',
  'OscillatorNode', 'SpeechSynthesisUtterance', 'speechSynthesis', 'Notification',
  'MediaQueryList', 'DOMParser', 'XMLSerializer', 'CSS', 'customElements', 'clients',
  'caches', 'registration', 'self', 'globalThis', 'window', 'document', 'location',
]);

/** 跨文件对账用：每个文件导出了哪些名字 */
const exportsOf = new Map();
/** 已知的目录（用于把 import 路径解析成绝对路径） */
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const code = stripCommentsAndStrings(src);
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default/.test(code)) names.add('default');
  exportsOf.set(path.resolve(f), names);
}

const problems = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  // ⚠️⚠️ **顺序是这里的全部难点，今天在这上面栽了两次**：
  //    ① import 语句的**路径就是字符串字面量** → 必须先在**原文**上解析 import；
  //    ② 挖 import 段也必须用**原文** —— 否则 `from '...'` 已经被剥成 `from  ;`，
  //       按"遇到 from 就结束"的逻辑会**一路吞掉 159 行正文**，
  //       把 `postToShell` 这种明明在用的名字全误报成死导入（假阳性）。
  //    ③ 剥注释/字符串只能用来**数用法**（防止注释里提一句名字就算"用了"）。
  //    正确顺序：原文 → 解析 import → 原文上挖掉 import → 再剥注释字符串 → 数用法。
  const rawImports = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    rawImports.push({ clause: m[1], source: m[2] });
  }
  const bodyRaw = removeImportStatements(src);
  const code = stripCommentsAndStrings(bodyRaw);

  // ---------- 收集本文件"有过定义"的名字 ----------
  const defined = new Set();
  // ⚠️⚠️ 下面这几条要**尽量宽**：宁可漏报，也不要假阳性。
  //    （假阳性的代价是"整个预检没人信"，比漏报严重得多 —— 这是今天用两次教训换来的。）
  // ① 任何 `function name` / `const name` / `class name`（**含非 export 的**，
  //    第一版漏了 `function eventTitleOf(){}` 这种，于是把定义得好好的函数报成"不存在"）
  for (const m of code.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // ② 方法简写 / 对象属性赋值成函数（`foo() {`、`async foo({a,b}) {`、`foo: () =>`、`foo = function`）
  //
  // ⚠️ 参数可能是**多行且嵌套**的（`async tick({ events, ... } = {}) {`），
  //    所以不能靠一条正则搞定 —— 用**括号配对**找 `)`，后面跟 `{` 就算"这里定义了一个函数"。
  //    第一版只认单行无嵌套的 `foo() {`，于是 `tick` 被误报成"调用了不存在的函数"。
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== '(') continue;
    let depth = 0; let end = -1;
    for (let j = i; j < code.length; j += 1) {
      if (code[j] === '(') depth += 1;
      else if (code[j] === ')') { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    // `)` 之后（跳过空白）是 `{` → 这是函数/方法的参数表
    let k = end + 1;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    if (code[k] !== '{') continue;
    // 名字在 `(` 之前（跳过 async/static/* 等修饰符）
    const before = code.slice(Math.max(0, i - 80), i);
    const m = before.match(/(?:async\s+|static\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*$/);
    if (m) defined.add(m[1]);
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
  // ③ **解构参数**、普通参数、catch(e) 这类局部名字（大头在这里）
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const t of m[1].split(',')) {
      const name = t.split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    }
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const t of m[1].split(',')) {
      const name = t.trim().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    }
  }
  for (const n of collectDestructuredParams(code)) defined.add(n);
  // ④ 对象字面量里的键（`{ foo: bar }` 的 foo 常被当函数名调用：`opts.foo()`）
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) defined.add(m[1]);

  // ---------- 收集 import（用上面从原文解析出来的）----------
  const imported = new Map();   // 本地名 -> 来源
  const importedRaw = new Map(); // 本地名 -> {source, orig}
  for (const { clause, source } of rawImports) {
    // 默认导入 / 命名空间导入
    const ns = clause.match(/^\s*\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) { imported.set(ns[1], source); importedRaw.set(ns[1], { source, orig: '*' }); }
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (def && !ns) { imported.set(def[1], source); importedRaw.set(def[1], { source, orig: 'default' }); }
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      // ⚠️⚠️ 必须先**剥掉注释**再按逗号切 —— 真实代码里 import 块中间常夹着大段注释
      //    （`app.js` 从 native.js 导入那一段的 clause 有 849 字符、里面 12 行注释），
      //    直接用 `split(',')` 会被注释里的逗号/花括号/中文标点带偏，
      //    结果只解析出前几个名字 → 后面那些被误报成"调用了不存在的函数"。
      const clean = braces[1]
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      for (const piece of clean.split(',')) {
        const t = piece.trim();
        if (!t) continue;
        const parts = t.split(/\s+as\s+/);
        const localName = (parts[1] || parts[0]).trim();
        const origName = parts[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(localName)) continue;
        imported.set(localName, source);
        importedRaw.set(localName, { source, orig: origName });
      }
    }
  }
  for (const n of imported.keys()) defined.add(n);

  // ---------- ① 调用了不存在的名字 ----------
  const called = new Set();
  for (const m of code.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!GLOBALS.has(name)) called.add(name);
  }
  const unknown = [...called].filter((n) => !defined.has(n));
  if (unknown.length) {
    problems.push({ file: rel, kind: '调用了找不到定义的名字（运行时走到就炸）', names: unknown });
  }

  // ---------- ② 导入了但正文里一次没用（死导入） ----------
  //
  // ⚠️ 判据：**在"挖掉 import 且剥掉注释/字符串"的正文里，一次都没出现**。
  //    允许前缀是 `.`（`foo.hhmm` 也算用了）。顺序错的后果见上面那段注释。
  const bodyOnly = code;
  const unusedImports = [];
  for (const [local] of imported) {
    const re = new RegExp(`(^|[^\\w$])${local.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
    const hits = (bodyOnly.match(re) || []).length;
    if (hits === 0) unusedImports.push(local);
  }
  if (unusedImports.length) {
    problems.push({ file: rel, kind: '导入了却一次没用（改名/删代码后的残留）', names: unusedImports });
  }

  // ---------- ③ 从本项目模块import了它没导出的东西 ----------
  const badNamed = [];
  for (const [local, info] of importedRaw) {
    if (info.orig === '*' ) continue;
    const src2 = info.source;
    if (!src2.startsWith('.')) continue;            // 外部包不查
    const abs = path.resolve(path.dirname(f), src2);
    const hit = [abs, `${abs}.js`, `${abs}.mjs`, path.join(abs, 'index.js')]
      .map((p) => path.resolve(p))
      .find((p) => exportsOf.has(p));
    if (!hit) continue;                              // 解析不了就不猜
    const names = exportsOf.get(hit);
    if (info.orig === 'default') { if (!names.has('default')) badNamed.push(`default`); continue; }
    if (!names.has(info.orig)) badNamed.push(info.orig);
  }
  if (badNamed.length) {
    problems.push({ file: rel, kind: '导入了对方**没有导出**的名字', names: badNamed });
  }
}

console.log('\n=== JS 机械预检 ===');
console.log(`  扫描 ${files.length} 个文件（web / core / server / android assets）`);

/**
 * 调试开关：`--dump <相对路径>` 打印**本脚本算出来的正文**与每个导入名字的命中次数。
 *
 * ⚠️ 为什么值得留一个调试口：这个文本转换器（挖 import + 剥注释/字符串/正则/模板串）
 *    在开发过程中改过五六轮，每一轮都是"猜哪里错了"浪费很多时间。
 *    有了它就能**直接看它算什么**（`alarmTitle` 到底是 0 次还是 1 次，一眼就有答案）。
 */
const dumpIdx = process.argv.indexOf('--dump');
if (dumpIdx >= 0) {
  const want = process.argv[dumpIdx + 1];
  const target = files.find((p) => path.relative(ROOT, p).replace(/\\/g, '/') === want);
  if (!target) {
    console.log(`  ✖ 找不到文件：${want}`);
    process.exit(2);
  }
  const src = fs.readFileSync(target, 'utf8');
  const rawImports = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    rawImports.push({ clause: m[1], source: m[2] });
  }
  const bodyRaw = removeImportStatements(src);
  const code = stripCommentsAndStrings(bodyRaw);
  console.log(`  dump: ${want}`);
  console.log(`    原文行数 ${src.split('\n').length} ／ 挖 import 后 ${bodyRaw.split('\n').length} ／ 剥后 ${code.split('\n').length}`);
  console.log(`    解析到 ${rawImports.length} 条 import；正文里各名字的命中次数：`);
  for (const imp of rawImports) {
    const braces = imp.clause.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').match(/\{([\s\S]*)\}/);
    if (!braces) continue;
    for (const piece of braces[1].split(',')) {
      const t = piece.trim(); if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      const local = (parts[1] || parts[0]).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
      const hits = (code.match(new RegExp(`(^|[^\\w$])${local}(?![\\w$])`, 'g')) || []).length;
      console.log(`      ${local.padEnd(24)} 命中 ${String(hits).padStart(2)}${hits === 0 ? '   ← 没用到' : ''}`);
    }
  }
  process.exit(0);
}

/** 会**真的炸**的问题（必须让构建失败） */
const FATAL = new Set(['调用了找不到定义的名字（运行时走到就炸）', '导入了对方**没有导出**的名字']);
const fatal = problems.filter((p) => FATAL.has(p.kind));
const tidy = problems.filter((p) => !FATAL.has(p.kind));

if (!problems.length) {
  console.log('  ✔ 三类问题都是 0（没有"调用了不存在的东西"、没有死导入、没有跨模块对不上）');
  process.exit(0);
}

// ---- ① 会炸的：必须红 ----
for (const p of fatal) {
  console.log(`  ✖ [${p.kind}] ${p.file}`);
  for (const n of p.names.slice(0, 12)) console.log(`        · ${n}`);
  if (p.names.length > 12) console.log(`        …（还有 ${p.names.length - 12} 个）`);
}
// ---- ② 整洁问题：只说，不挡 ----
if (tidy.length) {
  console.log(`\n  ── 以下 ${tidy.length} 个文件有"导入了却没用"（**不挡构建**，只是代码整洁问题）──`);
  for (const p of tidy) console.log(`  · ${p.file}：${p.names.join(', ')}`);
  console.log('    （想清就顺手删；不想清也不影响正确性。**别为了让这条变绿就乱删**。）');
}

const fatalCount = fatal.reduce((a, p) => a + p.names.length, 0);
const tidyCount = tidy.reduce((a, p) => a + p.names.length, 0);
console.log(`\n  会炸的 ${fatal.length} 个文件 / ${fatalCount} 处；整洁问题 ${tidy.length} 个文件 / ${tidyCount} 处。`);
if (!fatal.length) {
  console.log('  ✅ 会炸的那两类都是 0 —— 预检通过。');
  process.exit(0);
}
console.log('  ⚠️ 白名单在脚本顶部的 `GLOBALS`（语言/宿主内置）。');
console.log('     若某项确实是别处提供的，请加白名单并写清理由；**不要直接删断言**。');
process.exit(1);
