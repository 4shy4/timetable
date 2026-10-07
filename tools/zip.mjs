// 零依赖 zip 解压（只读中央目录 + inflate）。
//
// 为什么不用现成库：本项目"零依赖"是条硬规矩（客户机器上只放一个 node.exe）。
// Node 没有内置 zip，但 zip 格式足够简单，读中央目录就够了。
//
// ⚠️ 必须走**中央目录**，不能顺着"本地头"往下扫：
//    zip 允许把压缩大小写成 0，真实值放在数据**之后**的"数据描述符"里
//    （general purpose flag 位 3）。顺扫的实现会在这种包里只解出第一个文件就停
//    —— 我第一版就是这样，拿 10 个文件的测试包只解出 1 个。
//    中央目录在文件尾部，尺寸与偏移都是权威值。
//
// 限制：只支持 store(0) 与 deflate(8)；不支持 zip64（条目 >4GB）——
//       JDK / Android SDK 的包都到不了这个量级。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function listEntries(zipFile) {
  const fd = fs.openSync(zipFile, 'r');
  const size = fs.statSync(zipFile).size;
  const readAt = (offset, len) => {
    const b = Buffer.alloc(len);
    const got = fs.readSync(fd, b, 0, len, offset);
    return got === len ? b : b.subarray(0, got);
  };
  try {
    const cdOffset = findCentralDirectoryOffset(readAt, size);
    const out = [];
    let p = cdOffset;
    // 条目数从 EOCD 读，但这里直接扫到签名不匹配为止更省事
    for (;;) {
      const head = readAt(p, 46);
      if (head.length < 46 || head.readUInt32LE(0) !== SIG_CENTRAL) break;
      const nameLen = head.readUInt16LE(28);
      const extraLen = head.readUInt16LE(30);
      const commentLen = head.readUInt16LE(32);
      out.push({
        name: readAt(p + 46, nameLen).toString('utf8'),
        method: head.readUInt16LE(10),
        compSize: head.readUInt32LE(20),
        uncompSize: head.readUInt32LE(24),
        localOffset: head.readUInt32LE(42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function findCentralDirectoryOffset(readAt, size) {
  const tailLen = Math.min(size, 66_000);   // EOCD 后面最多 64KB 注释
  const tail = readAt(size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return tail.readUInt32LE(i + 16);
  }
  throw new Error('不是 zip 文件（找不到 EOCD）');
}

/**
 * 解压到目录。
 * @param {string} zipFile
 * @param {string} destDir
 * @param {{stripFirstDir?:string, onEntry?:(rel:string, n:number)=>void}} opts
 * @returns {number} 解出的文件数
 */
export function unzipTo(zipFile, destDir, opts = {}) {
  const { stripFirstDir, onEntry } = opts;
  const fd = fs.openSync(zipFile, 'r');
  let count = 0;
  const readAt = (offset, len) => {
    const b = Buffer.alloc(len);
    const got = fs.readSync(fd, b, 0, len, offset);
    return got === len ? b : b.subarray(0, got);
  };
  try {
    for (const e of listEntries(zipFile)) {
      let rel = e.name.replace(/\\/g, '/');
      if (!rel || rel.endsWith('/')) continue;                   // 目录条目
      if (stripFirstDir && rel.startsWith(`${stripFirstDir}/`)) {
        rel = rel.slice(stripFirstDir.length + 1);
      }
      if (!rel) continue;

      // 本地头的 extra 长度可能与中央目录不同，必须单独读
      const lh = readAt(e.localOffset, 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== SIG_LOCAL) {
        throw new Error(`本地头坏了：${e.name}`);
      }
      const dataStart = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = readAt(dataStart, e.compSize);

      let out;
      if (e.method === 0) out = raw;
      else if (e.method === 8) out = zlib.inflateRawSync(raw);
      else throw new Error(`不支持的压缩方式 ${e.method}（${e.name}）`);

      const target = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      count += 1;
      if (onEntry) onEntry(rel, count);
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}
