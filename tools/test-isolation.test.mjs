// 测试隔离的**机械化守卫**：测试套件绝对不许写进用户真实的 `data/`。
//
//
// ⚠️ 为什么要有这个文件（这不是"多写一个测试"，是**防止事故复发**的唯一办法）：
//    （它 → paths.js），到三百行之后才 `argv.push('--data-dir=…')`。而
//    `server/paths.js` 的 `DATA_DIR` 是**模块加载那一刻**算死的常量 ——
//    于是那次"隔离"完全没生效，`updateSettings()` 把夹具里的假端口
//    （127.0.0.1:58957）和假 Key 写进了用户真实的 `data/db.json`，覆盖了他的 AI 配置。
//    `tools/import-stats.test.mjs` 是同一类问题的第二个实例：它 import store 时
//    一个隔离都没设，而它调用的 `store.importCourses()` 结尾是 `persist()` ——
//    真的写盘（用户库里那门 `大学物理` 就是它的夹具）。
//
//    这两次都不是"某一行写错了"，而是**顺序**错了：代码读起来是对的，跑起来是错的。
//    这种错误靠 code review 会漏（我们就是漏了），只能靠机械检查。
//
// 两条互补的检查：
//   ① 静态扫描 tools/*.test.mjs：凡是 import/启动了"会碰数据目录的 server 模块"，
//      就必须在**那之前**设好 `TIMETABLE_DATA_DIR`（或 `--data-dir=`）——
//      而且必须**真的在它前面**（按字符位置比较，不是"文件里出现过就算"）。
//   ② 动态断言（这条是 bug 的直接复现）：在临时目录里 import store 并写一次 settings，
//      断言 `<repo>/data/db.json` 的**哈希 / mtime / 大小 / 是否存在**前后一字不差。
//      如果哪天 paths.js 的环境变量支持坏了，这条会立刻红 —— 而且是在**没碰到用户数据**之前红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const TOOLS_DIR = path.join(ROOT, 'tools');
const REAL_DB = path.join(ROOT, 'data', 'db.json');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? `  → ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * 注释处置（只针对"整行注释"和块注释）。
 *
 * ⚠️ 为什么不能简单地把 `//` 之后全砍掉：源码里有 `'http://127.0.0.1:7080'`，
 *    那样一砍会把同行的真代码也砍掉，扫描就会漏报（假绿）。
 *    所以只做两件安全的事：删块注释；丢掉**整行**都是注释的行。
 *    行尾注释留着 —— 它只会带来"多报"，不会"漏报"，而这个是守卫，宁可吵一点。
 */
function stripComments(src) {
  // 块注释：内容抹成空格但**保留换行**，这样下面的行号与真实文件一一对应
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    // 整行注释同样置空行（不是删行）—— 删行会让报出来的行号全部偏移，指错地方等于没指
    .map((line) => {
      const t = line.trim();
      return (t.startsWith('//') || t.startsWith('*') || t.startsWith('*/')) ? '' : line;
    })
    .join('\n');
}

/** `server/` 里"会冻结 DATA_DIR"的模块集合 —— 从源码里静态算出来，不写死名单 */
function frozenServerModules() {
  const files = fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'));
  const src = new Map(files.map((f) => [f, stripComments(fs.readFileSync(path.join(SERVER_DIR, f), 'utf8'))]));
  // 起点：直接 import './paths.js' 的（paths.js 自己也算：import 它 = 拿到 DATA_DIR 常量）
  const frozen = new Set(['paths.js', ...files.filter((f) => /\bfrom\s*['"]\.\/paths\.js['"]/.test(src.get(f) || ''))]);
  // 传递闭包：import 了任何一个已冻结模块的，同样会（间接）拿到那个常量
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of files) {
      if (frozen.has(f)) continue;
      for (const dep of frozen) {
        const re = new RegExp(`\\bfrom\\s*['"]\\./${dep.replace(/\./g, '\\.')}['"]`);
        if (re.test(src.get(f) || '')) { frozen.add(f); changed = true; break; }
      }
    }
  }
  return frozen;
}

/** 找出文件里所有"加载某个 server 模块"的位置（静态 import / 动态 import / require） */
function serverImportSites(src) {
  const sites = [];
  const pats = [
    /\bfrom\s*(['"`])\.\.\/server\/([\w.-]+)\1/g,          // import x from '../server/store.js'
    /\bimport\s*\(\s*(['"`])\.\.\/server\/([\w.-]+)\1/g,   // await import('../server/store.js')
    /\brequire\s*\(\s*(['"`])\.\.\/server\/([\w.-]+)\1/g,  // require('../server/store.js')
  ];
  for (const re of pats) {
    for (const m of src.matchAll(re)) sites.push({ index: m.index, mod: m[2] });
  }
  return sites.sort((a, b) => a.index - b.index);
}

/** 找出"起了 server/main.js 子进程"的位置（参数里的 --data-dir= 是另一种隔离方式） */
function mainSpawnSites(src) {
  const sites = [];
  const pats = [
    /['"`][^'"`]*server[\/\\]main\.js['"`]/g,       // 'server/main.js' / path.join(ROOT,'server','main.js') 的尾部
    /['"]server['"]\s*,\s*['"]main\.js['"]/g,       // path.join(ROOT, 'server', 'main.js')
  ];
  for (const re of pats) {
    for (const m of src.matchAll(re)) sites.push({ index: m.index });
  }
  return sites;
}

/** 行号（给报错指路用） */
function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/**
 * "隔离证据"必须**真的是赋值或传参**，不能只是"文中出现了这几个字"。
 *
 * ⚠️ 判据要是放宽成 /TIMETABLE_DATA_DIR/ 就会有一个明显的漏洞：随便哪个套件里
 *    写一句 `const NOTE = 'TIMETABLE_DATA_DIR'`（或者守卫自己的正则字面量）都能过关，
 *    而数据其实照样写进用户的真库。所以只认这三种形状：
 *      · process.env.TIMETABLE_DATA_DIR = …      （本进程隔离，测试的首选）
 *      · TIMETABLE_DATA_DIR: …                   （起子进程时塞进 env）
 *      · --data-dir=…                            （argv 或子进程命令行）
 */
const ISOLATION_RE = /(?:process\.env\.TIMETABLE_DATA_DIR\s*=|TIMETABLE_DATA_DIR\s*:|--data-dir=)/g;

/** 第一次出现"真隔离"的字符位置；没有就 -1（⚠️ /g 正则要复位 lastIndex，否则第二次调用会从上次位置接着找） */
function firstIsolationIndex(src) {
  ISOLATION_RE.lastIndex = 0;
  const m = ISOLATION_RE.exec(src);
  ISOLATION_RE.lastIndex = 0;
  return m ? m.index : -1;
}

// ---------------------------------------------------------------------------
// ① 静态扫描
// ---------------------------------------------------------------------------
section('① 静态扫描 tools/*.test.mjs：碰数据的套件必须在 import/启动**之前**隔离');

const frozen = frozenServerModules();
console.log(`  （会冻结 DATA_DIR 的 server 模块：${[...frozen].sort().join(', ')}）`);

const suites = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.test.mjs')).sort();
const clean = [];
const offenders = [];

for (const name of suites) {
  // ⚠️ 跳过本文件自己：它**故意**内嵌了"坏样本"字符串（`import('../server/store.js')`
  //    之类）来验证判据本身是否有效，扫描它会必然误报自己。
  //    本文件的真实安全性不靠静态扫描保证，而靠下面 ② 那条动态断言（哈希前后一致）——
  //    那比静态扫描更强：它证明的正是"这个进程写不进用户的真库"。
  if (name === 'test-isolation.test.mjs') continue;

  const raw = fs.readFileSync(path.join(TOOLS_DIR, name), 'utf8');
  const src = stripComments(raw);

  const imports = serverImportSites(src).filter((s) => frozen.has(s.mod));
  const spawns = mainSpawnSites(src);
  if (!imports.length && !spawns.length) continue;   // 跟数据目录无关的套件，跳过

  const firstIso = firstIsolationIndex(src);

  const problems = [];
  if (imports.length) {
    const first = imports[0];
    // 关键判据：隔离**必须**在第一次加载"冻结模块"之前 —— 按位置比，不看"文件里有没有"
    if (firstIso < 0) {
      problems.push(`加载了 server/${first.mod}（第 ${lineOf(src, first.index)} 行）却完全没有 TIMETABLE_DATA_DIR / --data-dir=`);
    } else if (firstIso > first.index) {
      problems.push(`隔离写在 server/${first.mod} 加载（第 ${lineOf(src, first.index)} 行）**之后**（第 ${lineOf(src, firstIso)} 行）—— 太晚了，paths.js 早算完 DATA_DIR 了`);
    }
  }
  for (const sp of spawns) {
    const window = src.slice(sp.index, sp.index + 400);
    const isolatedBefore = firstIso >= 0 && firstIso < sp.index;
    if (!isolatedBefore && !/--data-dir=/.test(window)) {
      problems.push(`第 ${lineOf(src, sp.index)} 行启动 server/main.js 但命令行里没有 --data-dir=`);
    }
  }

  if (problems.length) offenders.push({ name, problems });
  else clean.push(name);
}

check(`扫描了 ${suites.length} 个套件，其中 ${clean.length + offenders.length} 个与数据目录有关`,
  suites.length > 0, `suites=${suites.length}`);
check('⭐ 没有任何套件会在未隔离的情况下碰真实 data/',
  offenders.length === 0,
  offenders.map((o) => `\n      · ${o.name}: ${o.problems.join('；')}`).join(''));
if (clean.length) console.log(`  （已正确隔离：${clean.join(', ')}）`);

// ⚠️ 守卫自身的"反向验证"留痕：守卫必须能抓到一个明显的坏例子。
//    这里用**合成样本**当场验一遍判据（不落盘、不 import），保证扫描逻辑不是空转。
{
  const badSample = [
    "import fs from 'node:fs';",
    "const store = await import('../server/store.js');",   // ← 先碰数据
    "process.env.TIMETABLE_DATA_DIR = '/tmp/x';",          // ← 隔离在之后（典型的"看着对"）
  ].join('\n');
  const goodSample = [
    "process.env.TIMETABLE_DATA_DIR = '/tmp/x';",
    "const store = await import('../server/store.js');",
  ].join('\n');
  const badImports = serverImportSites(badSample).filter((s) => frozen.has(s.mod));
  const badIso = firstIsolationIndex(badSample);
  const goodImports = serverImportSites(goodSample).filter((s) => frozen.has(s.mod));
  const goodIso = firstIsolationIndex(goodSample);
  check('守卫判据自检：隔离在 import 之后 → 判为坏',
    badImports.length > 0 && badIso > badImports[0].index);
  check('守卫判据自检：隔离在 import 之前 → 判为好',
    goodImports.length > 0 && goodIso >= 0 && goodIso < goodImports[0].index);
  check('守卫判据自检：只是"提到"名字不算隔离（防止用一句字符串糊弄过去）',
    firstIsolationIndex("const NOTE = 'TIMETABLE_DATA_DIR';") < 0);
  const commented = stripComments("// import '../server/store.js'\nconst x = 1; // http://a.b/c");
  check('守卫判据自检：整行注释不算引用（否则注释一提 store.js 就误报）',
    serverImportSites(commented).length === 0 && commented.includes('http://a.b/c'));
}

// ---------------------------------------------------------------------------
// ② 动态断言：真写一次，看用户真库的哈希有没有动
// ---------------------------------------------------------------------------
section('② 动态断言：在临时目录写一次 settings，真实 data/db.json 必须一动不动');

/** 真实库的指纹：存在性 + 大小 + mtime + sha256（用 mtime 而不是"内容哈希"单独一条，
 *  是因为"文件被重写成了同样的内容"也算碰过用户数据，必须能看出来） */
function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    return {
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    return { exists: false };
  }
}

{
  const before = fingerprint(REAL_DB);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-isolation-guard-'));
  // ⚠️ 清理要**两条**路：in-line 清一次（正常路径立即清掉，确定性强），
  //    exit 钩子再兜一次（中途抛异常也能清）。只挂 exit 钩子实测会在某些
  //    被 runner 拉起/异常退出的路径上漏下空目录（Windows 上 rmSync 与 runner
  //    收尾有竞争，异常被 catch 吞掉就成了"静默漏"）。
  const cleanupTmp = () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanupTmp);

  // ⚠️ 顺序：这一行必须在 import store 之前（本文件自己也得守这条规矩）
  process.env.TIMETABLE_DATA_DIR = TMP;
  const store = await import('../server/store.js');
  const { DATA_DIR, DB_FILE } = await import('../server/paths.js');

  check('⭐ 环境变量真的把 DATA_DIR 改了（paths.js 的覆盖生效）',
    DATA_DIR === path.resolve(TMP), `DATA_DIR=${DATA_DIR}`);

  // 故意写一份**一眼能认出来**的东西（假 Key，不是任何真实凭据）
  store.updateSettings({
    ai: { baseUrl: 'http://127.0.0.1:1', apiKey: 'isolation-guard-not-a-real-key', model: 'isolation-guard' },
  });
  check('写入落在临时目录里（不是空转：临时库里真的出现了 db.json）',
    fs.existsSync(path.join(TMP, 'db.json')) && DB_FILE.startsWith(TMP), `${DB_FILE}`);

  const after = fingerprint(REAL_DB);
  check('⭐⭐ 真实 data/db.json 的哈希 / mtime / 大小 / 存在性前后完全一致',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  check('（对照）临时库自己确实被改写了 —— 证明上面那次 updateSettings 真的落了盘',
    fs.existsSync(path.join(TMP, 'db.json'))
    && fingerprint(path.join(TMP, 'db.json')).size > 0);

  // 正常路径立即清理（assert 已经把该留的证据记进 failures，删掉不影响报错内容）
  cleanupTmp();
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}

// ⚠️ 两种跑法要区别对待（这个文件既想在 `npm test` 里跑，也想直接跑）：
//   · 被 `node --test` 拉起时，本文件是 runner 的**子进程**：这时再 process.exit() 会
//     在 runner 眼里变成"这个文件没跑完就没了"，可能把整套测试搞成假的失败/假绿。
//     所以这时**不 exit**，而是注册一个汇总用例，失败就 assert 抛出去（让 runner 正常报红）。
//   ⚠️ 判据用 NODE_TEST_CONTEXT：node:test 在它拉起的子进程里会设这个变量。
const UNDER_NODE_TEST = !!process.env.NODE_TEST_CONTEXT;
if (UNDER_NODE_TEST) {
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  test('测试隔离守卫：静态扫描 + 动态哈希断言', () => {
    assert.equal(fail, 0, `有 ${fail} 项没通过：\n${failures.join('\n')}`);
  });
} else {
  process.exit(fail ? 1 : 0);
}
