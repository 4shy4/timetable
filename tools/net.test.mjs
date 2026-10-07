// 手机接入（局域网 + HTTPS）相关逻辑的单元测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-net-test-'));
process.argv.push(`--data-dir=${TMP}`, '--lan');

const paths = await import('../server/paths.js');
const { makeQrMatrix, decodeQrMatrix } = await import('../core/qrcode.js');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('地址排序：优先家用网段，虚拟网卡排最后', () => {
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    if (ip.startsWith('100.')) return 4;
    return 3;
  };
  const list = ['100.64.0.9', '192.168.77.5', '198.51.100.7', '198.51.100.9', '8.8.8.8'];
  const sorted = [...list].sort((a, b) => score(a) - score(b));
  assert.equal(sorted[0], '192.168.77.5', '家用 192.168 应排最前（手机最可能连上）');
  assert.equal(sorted[sorted.length - 1], '100.64.0.9', '100.x 虚拟网卡应排最后');
});

test('lanUrls 生成带端口与协议的地址', () => {
  const urls = paths.lanUrls(7443, 'https');
  for (const u of urls) {
    assert.match(u, /^https:\/\/\d+\.\d+\.\d+\.\d+:7443$/);
  }
  const httpUrls = paths.lanUrls(7080, 'http');
  for (const u of httpUrls) assert.match(u, /^http:\/\/\d+\.\d+\.\d+\.\d+:7080$/);
});

test('默认端口与 HTTPS 端口符合约定，且 --lan 时 HOST 是 0.0.0.0', () => {
  assert.equal(paths.PORT, 7080);
  assert.equal(paths.HTTPS_PORT, 7443);
  assert.equal(paths.LAN, true);
  assert.equal(paths.HOST, '0.0.0.0');
});

test('证书不存在时 httpsCertAvailable 为假，且 certInfo 不抛错', () => {
  assert.equal(typeof paths.httpsCertAvailable(), 'boolean');
  assert.doesNotThrow(() => paths.certInfo());
});

test('证书目录常量指向 data/cert', () => {
  assert.equal(paths.CERT_DIR, path.join(TMP, 'cert'));
  assert.match(paths.PFX_FILE, /cert[\\/]server\.pfx$/);
});

test('用来给手机扫的地址能装进二维码并被读回来', () => {
  // 模拟真实场景：/api/net 给出的首选地址直接进二维码
  const target = paths.lanUrls(paths.HTTPS_PORT, 'https')[0] || 'https://192.168.77.1:7443';
  const { modules, version } = makeQrMatrix(target, { ecl: 'M' });
  assert.equal(decodeQrMatrix(modules), target, '二维码内容与目标地址不一致（手机扫出来会打不开）');
  assert.ok(version <= 4, `地址很短，不该用到高版本：v${version}`);
});

test('二维码在 http 地址下同样可用（没有证书时的兜底）', () => {
  const target = paths.lanUrls(paths.PORT, 'http')[0] || 'http://192.168.77.1:7080';
  const { modules } = makeQrMatrix(target);
  assert.equal(decodeQrMatrix(modules), target);
});
