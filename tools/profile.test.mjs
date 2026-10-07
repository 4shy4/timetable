// 描述文件（.mobileconfig）结构自检。
//
// 为什么值得写测试：这个文件的失败模式是**静默的** —— iOS 拿到一个结构不对的
// 描述文件时不会报错，只会"毫无反应"（不弹安装提示、也不下载）。我们为此浪费了
// 好几轮，每次都去改证书内容，其实真正的问题是文件的整体形状。所以把形状钉死。
//
// 直接跑：node tools/profile.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMobileconfig, buildProfile, toPlist, plistData, uuid } from '../server/profile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA_CRT = path.join(ROOT, 'data', 'cert', 'timetable-ca.crt');
const EXPORTED = path.join(ROOT, 'build', 'timetable.mobileconfig');

/** 从描述文件 XML 里抠出内嵌的证书 base64（必须包在 `<data>` 里）。 */
function embeddedCertB64(xml) {
  const m = xml.match(/<key>PayloadContent<\/key>\s*<data>([A-Za-z0-9+/=\s]+)<\/data>/);
  assert.ok(m, '描述文件里找不到 <data> 形式的内嵌证书');
  return m[1].replace(/\s+/g, '');
}

/** 所有 PayloadUUID 值。 */
function uuids(xml) {
  return [...xml.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

test('plist 序列化：类型与转义', () => {
  assert.equal(toPlist('a&b<c>"d"'), '<string>a&amp;b&lt;c&gt;&quot;d&quot;</string>');
  assert.equal(toPlist(true), '<true/>');
  assert.equal(toPlist(false), '<false/>');
  assert.equal(toPlist(3), '<integer>3</integer>');
  assert.match(toPlist(['x']), /<array>\n\s*<string>x<\/string>\n\s*<\/array>/);
  assert.match(toPlist({ k: 'v' }), /<dict>\n\s*<key>k<\/key>\n\s*<string>v<\/string>\n\s*<\/dict>/);
  // 嵌套：证书载荷就是 array 里套 dict
  assert.match(toPlist([{ a: 1 }]), /<array>[\s\S]*<dict>[\s\S]*<key>a<\/key>[\s\S]*<\/dict>[\s\S]*<\/array>/);
});

test('plist 序列化：data 类型必须是 <data> 而不是 <string>', () => {
  // 回归：曾经把证书 base64 用 <string> 发出去，iOS 报「字段"PayloadContent"无效」。
  assert.equal(toPlist(plistData('MIIB')), '<data>MIIB</data>');
  // 带缩进时也要正确
  assert.equal(toPlist(plistData('MIIB'), '  '), '  <data>MIIB</data>');
  // 不能被当成普通 dict 展开
  assert.ok(!toPlist(plistData('MIIB')).includes('<dict>'), '不能被当成字典');
  assert.ok(toPlist(plistData('MIIB')).includes('MIIB'), '内容要原样保留');
  assert.equal(toPlist({ a: plistData('AA==') }), '<dict>\n  <key>a</key>\n  <data>AA==</data>\n</dict>');
});

test('uuid：形状是 v4 且不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const u = uuid();
    assert.match(u, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/, `坏 UUID: ${u}`);
    assert.ok(!seen.has(u), `UUID 重复: ${u}`);
    seen.add(u);
  }
});

test('描述文件：整体形状符合 Apple Configuration Profile 规范', () => {
  const xml = buildMobileconfig('MIIBxxx');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'XML 声明');
  assert.ok(xml.includes('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'), 'Apple DTD');
  assert.ok(xml.includes('<plist version="1.0">'), 'plist 根');
  assert.ok(xml.trimEnd().endsWith('</plist>'), '闭合');
  // 顶层必须是 Configuration，否则 iOS 不认
  assert.ok(xml.includes('<key>PayloadType</key>\n  <string>Configuration</string>'), '顶层 PayloadType');
  // 证书载荷必须是 com.apple.security.root（根证书），不是 .cert（个人身份）
  assert.ok(xml.includes('<string>com.apple.security.root</string>'), '根证书载荷类型');
  assert.ok(!xml.includes('com.apple.security.pkcs12'), '不该出现 p12 载荷');
  // 证书内容必须是 <data>（Apple 规范里 PayloadContent 是 data 类型）。
  // 用 <string> 的话 iOS 直接报「字段"PayloadContent"无效」。
  assert.ok(/<key>PayloadContent<\/key>\s*<data>/.test(xml), '证书内容必须是 <data>');
  assert.ok(!/<key>PayloadContent<\/key>\s*<string>/.test(xml), '证书内容不能是 <string>');
  // 不许把 PEM 塞进去
  assert.ok(!xml.includes('BEGIN CERTIFICATE'), '不能是 PEM');
});

test('描述文件：两个 UUID 都是新的（固定 UUID 会让 iOS 跳过安装）', () => {
  const a = uuids(buildMobileconfig('MIIBxxx'));
  const b = uuids(buildMobileconfig('MIIBxxx'));
  assert.equal(a.length, 2, '应有顶层 + 载荷两个 UUID');
  assert.notEqual(a[0], a[1], '同一份里两个 UUID 不能相同');
  // 两次生成必须完全不同 —— 否则设备上装过旧的就"不更新"
  assert.notDeepEqual(a, b, '两次生成的 UUID 集合必须不同');
});

test('描述文件：载荷声明了文件名，且没有 PayloadRemovalDisallowed', () => {
  const xml = buildMobileconfig('MIIBxxx');
  assert.ok(xml.includes('<key>PayloadCertificateFileName</key>'), '要有证书文件名');
  assert.ok(xml.includes('<string>timetable-ca.crt</string>'), '文件名应带 .crt 后缀');
  assert.ok(xml.includes('<key>PayloadRemovalDisallowed</key>\n  <false/>'), '允许用户移除');
});

test('真实 CA：导出的文件内嵌的就是 data/cert 里那把 CA 证书', (t) => {
  if (!fs.existsSync(CA_CRT) || !fs.existsSync(EXPORTED)) {
    t.skip('还没生成证书 / 还没导出描述文件');
    return;
  }
  const caBytes = fs.readFileSync(CA_CRT);
  const embedded = Buffer.from(embeddedCertB64(fs.readFileSync(EXPORTED, 'utf8')), 'base64');
  assert.deepEqual(embedded, caBytes, '内嵌证书必须与 timetable-ca.crt 逐字节一致');
  // DER 证书以 0x30（SEQUENCE）开头
  assert.equal(caBytes[0], 0x30, 'CA 应该是 DER 编码');
});

test('真实 CA：内嵌证书确实是 CA=TRUE 的根（不是自相矛盾的叶子证书）', (t) => {
  if (!fs.existsSync(CA_CRT)) {
    t.skip('还没生成证书');
    return;
  }
  const caBytes = fs.readFileSync(CA_CRT);
  // 不引入任何依赖：直接在 DER 里找 BasicConstraints 扩展 OID 2.5.29.19 的编码，
  // 以及"CA=TRUE"的最短形式 30 03 01 01 FF。
  const der = caBytes.toString('latin1');
  assert.ok(der.includes('\x06\x03\x55\x1d\x13'), '应含 BasicConstraints 扩展 (2.5.29.19)');
  assert.ok(der.includes('\x30\x03\x01\x01\xff'), 'BasicConstraints 应为 CA=TRUE');
  assert.ok(der.includes('\x06\x03\x55\x1d\x0f'), '应含 KeyUsage 扩展 (2.5.29.15)');
});
