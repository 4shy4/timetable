// 把「未来 N 天」的分享文本打印出来 —— 和 App 写进 `Documents/timetable-plan.txt`
// 的**是同一个函数**（core/share-plan.js 的 buildSharePlan），所以看到的就是真格式。
//
// 为什么需要它：
//   1. 用户在快捷指令那边要判断"该取哪个文件、该用什么类型过滤"，
//      得先**看到文件里到底是什么样**，而不是听我描述。
//   2. 这条通道坏了（Siri 念不出来 / 念的是旧的）时，可以先在这里确认
//      "内容本身对不对"，把"内容错"和"传输错"分开。
//
// 用法：
//   node tools/export-share-plan.mjs                 # 用 data/db.json，未来 7 天
//   node tools/export-share-plan.mjs --days 3
//   node tools/export-share-plan.mjs --file data/db.json --write out.txt

import fs from 'node:fs';
import { buildSharePlan } from '../core/share-plan.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1];
    if (v && !v.startsWith('--')) { args[k] = v; i += 1; } else args[k] = true;
  }
}

const file = typeof args.file === 'string' ? args.file : 'data/db.json';
if (!fs.existsSync(file)) {
  console.error('找不到 ' + file + '（用 --file 指定别的）');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(db.events) ? db.events : [];
// ⚠️ termStart 从 settings 里取 —— 展开"第几周的课"要用它，漏了会让课程算不出来
const termStart = (db.settings && db.settings.termStart) || '';
const days = Number(args.days) > 0 ? Number(args.days) : 7;

const r = buildSharePlan(events, { now: new Date(), days, termStart });

if (typeof args.write === 'string') {
  // ⚠️ 用 utf8 写、不加 BOM —— 和 App 侧 `text.write(atomically:encoding:.utf8)` 一致
  fs.writeFileSync(args.write, r.text, 'utf8');
  console.log('已写入 ' + args.write);
}

console.log('--- 数据源：' + file + '（' + events.length + ' 条事件）---');
console.log('--- 窗口：未来 ' + days + ' 天，命中 ' + r.count + ' 个实例 ---');
console.log('--- 文件格式：纯文本 UTF-8（无 BOM），换行 LF，扩展名 .txt ---');
console.log('--- 下面就是文件内容的原样 ---');
console.log(r.text);
console.log('--- 结束 ---');
