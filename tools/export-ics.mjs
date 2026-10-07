// 把当前日程导出成一个 `.ics` 文件到 build/ —— 给 iPad「一次性导入」用。
//
// 为什么要这条路（和订阅的区别）：
//   iOS 的「添加已订阅的日历」要对 URL 做**校验**（TLS 证书、HEAD、Content-Type…），
//   自签名证书没被真正信任时会直接报「验证失败，请编辑URL，然后重试」，
//   而且**它不会告诉你原因**。
//   而把一个 .ics 文件通过隔空投送/邮件/文件 App 送过去、点开导进日历，
//   **完全不经过 URL 校验，也不碰证书** —— 是最不可能失败的兜底。
//
// 代价：一次性快照。之后电脑上改了日程，iPad 的日历**不会**跟着变。
//       课程表这种一学期基本固定的东西，这个代价通常可以接受。
//
// 用法：
//   node tools/export-ics.mjs
//   node tools/export-ics.mjs --out build/foo.ics
//
// ⚠️ 这个脚本**不需要**服务器在跑，直接读 data/db.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCalendar } from '../core/ics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'data', 'db.json');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 && argv[outIdx + 1]
  ? path.resolve(ROOT, argv[outIdx + 1])
  : path.join(ROOT, 'build', 'timetable.ics');

if (!fs.existsSync(DB)) {
  console.error(`找不到数据文件：${DB}`);
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const events = Array.isArray(db.events) ? db.events : [];
const settings = db.settings || {};

if (!events.length) {
  console.error('db.json 里一条日程都没有，导出的日历会是空的 —— 先确认数据文件对不对。');
  process.exit(1);
}

const ics = buildCalendar({ events, settings });

// ---- 自检：这些是 iOS 会挑的地方，宁可这里报错也不要让用户拿到装不上的文件 ----
const lines = ics.replace(/\r\n$/, '').split('\r\n');
const vevents = lines.filter((l) => l === 'BEGIN:VEVENT').length;
const alarms = lines.filter((l) => l === 'BEGIN:VALARM').length;
const long = lines.filter((l) => Buffer.byteLength(l, 'utf8') > 75);
const uids = lines.filter((l) => l.startsWith('UID:')).map((l) => l.slice(4));

const checks = [
  ['以 BEGIN:VCALENDAR 开头', ics.startsWith('BEGIN:VCALENDAR\r\n')],
  ['以 END:VCALENDAR 收尾', ics.endsWith('END:VCALENDAR\r\n')],
  ['有 VERSION:2.0', lines.includes('VERSION:2.0')],
  ['有事件', vevents > 0],
  ['有闹钟（否则导进去也不会响）', alarms > 0],
  ['没有超过 75 字节的行', long.length === 0],
  ['UID 互不重复', new Set(uids).size === uids.length],
  ['没有裸 LF（必须全 CRLF）', !/[^\r]\n/.test(ics)],
];
let bad = 0;
for (const [name, pass] of checks) {
  if (!pass) bad += 1;
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, ics, 'utf8');

console.log('');
console.log(`已导出：${outFile}`);
console.log(`大小  ：${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
console.log(`内容  ：${vevents} 个日程 / ${alarms} 个闹钟`);
console.log('');
console.log('传到 iPad：隔空投送 / 邮件附件 / 文件 App，然后在 iPad 上点开它 →');
console.log('          日历会弹「添加全部」→ 确认。整个过程不需要证书，也不需要订阅 URL。');
process.exit(bad ? 1 : 0);
