// zip 解压的单测。
//
// 这个 reader 是"工具链能不能装上"的关键一环，而且**失败方式很隐蔽**：
// 早期版本顺着本地头扫，遇到"带数据描述符"的 zip（压缩大小写在数据之后）
// 只解出第一个文件就停下，却不报错。所以这里专门造一个那种包来测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { unzipTo, listEntries } from './zip.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-zip-'));
let seq = 0;
function workdir() {
  const d = path.join(TMP, `w${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 手写一个最小 zip。
 * @param {Array<{name:string,data:Buffer,descriptor?:boolean}>} entries
 *   descriptor=true 时把压缩大小写成 0 并追加数据描述符（模拟 C# / Java 的写法）
 */
function makeZip(entries, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(e.data) : crc32(e.data);
    const comp = store ? e.data : zlib.deflateRawSync(e.data);
    const method = store ? 0 : 8;
    const flag = e.descriptor ? 0x08 : 0;
    const compField = e.descriptor ? 0 : comp.length;
    const uncompField = e.descriptor ? 0 : e.data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 10);          // time+date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compField, 18);
    lh.writeUInt32LE(uncompField, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const parts = [lh, nameBuf, comp];
    let desc = Buffer.alloc(0);
    if (e.descriptor) {
      desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);   // 可选签名
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(comp.length, 8);
      desc.writeUInt32LE(e.data.length, 12);
      parts.push(desc);
    }
    locals.push(...parts);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flag, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length + desc.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

// 小工具：老 Node 没有 zlib.crc32
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function writeZip(dir, buf, name = 't.zip') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

// ---------------------------------------------------------------------------

test('解压普通 deflate zip：文件数与内容都对', () => {
  const d = workdir();
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'sub/b.txt', data: Buffer.from('world'.repeat(500)) },
    { name: 'sub/deep/c.bin', data: cryptoish(4096) },
  ];
  const zip = writeZip(d, makeZip(entries));
  const out = path.join(d, 'out');
  const n = unzipTo(zip, out);

  assert.equal(n, 3, '应当解出 3 个文件');
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(out, 'sub/b.txt'), 'utf8'), 'world'.repeat(500));
  assert.deepEqual(fs.readFileSync(path.join(out, 'sub/deep/c.bin')), entries[2].data);
});

test('**带数据描述符的 zip 也要解全**（早期版本在这里只解出第一个文件）', () => {
  const d = workdir();
  const entries = [
    { name: 'one.txt', data: Buffer.from('first'), descriptor: true },
    { name: 'two.txt', data: Buffer.from('second'.repeat(200)), descriptor: true },
    { name: 'three.txt', data: Buffer.from('third'), descriptor: true },
  ];
  const zip = writeZip(d, makeZip(entries));

  // 先确认这个包真的是"本地头里没有尺寸"（否则测不到点子上）
  const raw = fs.readFileSync(zip);
  assert.equal(raw.readUInt32LE(18), 0, '本地头的压缩大小应当是 0（有数据描述符）');

  const out = path.join(d, 'out');
  const n = unzipTo(zip, out);
  assert.equal(n, 3, `应当解出 3 个文件，实际 ${n}`);
  assert.equal(fs.readFileSync(path.join(out, 'one.txt'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(out, 'two.txt'), 'utf8'), 'second'.repeat(200));
  assert.equal(fs.readFileSync(path.join(out, 'three.txt'), 'utf8'), 'third');
});

test('store（不压缩）也能解', () => {
  const d = workdir();
  const zip = writeZip(d, makeZip([{ name: 'plain.txt', data: Buffer.from('no compression') }], { store: true }));
  const out = path.join(d, 'out');
  assert.equal(unzipTo(zip, out), 1);
  assert.equal(fs.readFileSync(path.join(out, 'plain.txt'), 'utf8'), 'no compression');
});

test('stripFirstDir 去掉顶层目录（Android 命令行工具就是这样装的）', () => {
  const d = workdir();
  const zip = writeZip(d, makeZip([
    { name: 'cmdline-tools/bin/sdkmanager.bat', data: Buffer.from('x') },
    { name: 'cmdline-tools/lib/foo.jar', data: Buffer.from('y') },
    { name: 'other/keep.txt', data: Buffer.from('z') },
  ]));
  const out = path.join(d, 'out');
  unzipTo(zip, out, { stripFirstDir: 'cmdline-tools' });

  assert.ok(fs.existsSync(path.join(out, 'bin', 'sdkmanager.bat')), '应当去掉 cmdline-tools/ 前缀');
  assert.ok(fs.existsSync(path.join(out, 'lib', 'foo.jar')));
  assert.ok(fs.existsSync(path.join(out, 'other', 'keep.txt')), '不在前缀里的原样保留');
});

test('目录条目被跳过，不当成文件写出来', () => {
  const d = workdir();
  const zip = writeZip(d, makeZip([
    { name: 'dir/', data: Buffer.alloc(0) },
    { name: 'dir/f.txt', data: Buffer.from('ok') },
  ]));
  const out = path.join(d, 'out');
  const n = unzipTo(zip, out);
  assert.equal(n, 1);
  assert.ok(fs.statSync(path.join(out, 'dir')).isDirectory());
});

test('listEntries 报告条目元信息', () => {
  const d = workdir();
  const zip = writeZip(d, makeZip([
    { name: 'a.txt', data: Buffer.from('aaaa') },
    { name: 'b.txt', data: Buffer.from('bbbbbbbb') },
  ]));
  const list = listEntries(zip);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.name), ['a.txt', 'b.txt']);
  assert.ok(list.every((e) => e.method === 8));
  assert.equal(list[1].uncompSize, 8);
});

test('不是 zip 的文件要报错，不能静默返回 0', () => {
  const d = workdir();
  const bad = path.join(d, 'bad.zip');
  fs.writeFileSync(bad, Buffer.from('this is definitely not a zip file at all'));
  assert.throws(() => unzipTo(bad, path.join(d, 'out')), /不是 zip|EOCD/);
});

test('能和系统 tar 解出一样的内容（交叉验证）', () => {
  const d = workdir();
  const entries = [
    { name: 'x/1.txt', data: Buffer.from('one') },
    { name: 'x/2.txt', data: Buffer.from('two'.repeat(1000)) },
    { name: 'x/3.txt', data: Buffer.from('three') },
  ];
  const zip = writeZip(d, makeZip(entries));

  const mine = path.join(d, 'mine');
  unzipTo(zip, mine);

  // Windows 10+ 自带 bsdtar，能解 zip；不在就跳过（不算失败）
  const theirs = path.join(d, 'theirs');
  fs.mkdirSync(theirs, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', theirs], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('  （本机 tar 解不了 zip，跳过交叉验证）');
    return;
  }
  for (const e of entries) {
    const a = fs.readFileSync(path.join(mine, e.name));
    const b = fs.readFileSync(path.join(theirs, e.name));
    assert.deepEqual(a, b, `${e.name} 与 tar 的结果不一致`);
  }
});

// ---------------------------------------------------------------------------
// 附带：确认系统 tar 可用（引导脚本在极端情况下可退化为用它）
// ---------------------------------------------------------------------------
test('系统自带 tar 可用（备选解压路径）', () => {
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'tar 不可用');
  assert.match(r.stdout + r.stderr, /tar/i);
});

// 造点"像二进制"的数据，避免全是可压缩的重复内容
function cryptoish(n) {
  const b = Buffer.alloc(n);
  let x = 12345;
  for (let i = 0; i < n; i += 1) {
    x = (x * 0x41C64E6D + 12345) & 0x7fffffff;
    b[i] = x & 0xff;
  }
  return b;
}
