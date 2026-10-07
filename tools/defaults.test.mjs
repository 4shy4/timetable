// 缺省值深合并：老数据补新增字段。
//
// 这是**数据安全**相关的逻辑：补错了会覆盖用户的设置，所以边界要钉住。
//
// 起因：真机端到端测出安卓端 `/api/state` 的 `settings.courseDigest` 是 null
// —— 老库里没有这个键，而原来的浅合并（`{...DEFAULT, ...loaded}`）补不上嵌套键。
import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeDefaults } = await import('../core/defaults.js');
const { defaultDigestSettings } = await import('../core/course-digest.js');

test('补上缺失的嵌套键（核心场景）', () => {
  const loaded = { settings: { owner: '我', termStart: '2026-09-21' } };
  const defaults = {
    settings: { owner: '', termStart: '', courseDigest: { enabled: false, slots: { noon: { on: true, at: '12:30' } } } },
  };
  const out = mergeDefaults(loaded, defaults);
  assert.equal(out.settings.owner, '我', '用户的值必须保留');
  assert.equal(out.settings.termStart, '2026-09-21');
  assert.deepEqual(out.settings.courseDigest, { enabled: false, slots: { noon: { on: true, at: '12:30' } } },
    '缺失的嵌套键要补上');
});

test('用户的值优先，哪怕是 false / 0 / 空串', () => {
  // ⚠️ 这是最容易写错的地方：不能因为 `false` 是 falsy 就当"没设置"而用缺省值覆盖。
  const loaded = { a: false, b: 0, c: '', d: null, e: [] };
  const defaults = { a: true, b: 99, c: 'x', d: 'yy', e: [1, 2] };
  const out = mergeDefaults(loaded, defaults);
  assert.equal(out.a, false, 'false 是有效值，不能被覆盖');
  assert.equal(out.b, 0, '0 是有效值');
  assert.equal(out.c, '', '空串是有效值');
  assert.equal(out.d, 'yy', 'null 视为"没有" → 用缺省');
  assert.deepEqual(out.e, [], '空数组是有效值（数组整体替换，不逐项合并）');
});

test('undefined / 缺键 → 用缺省', () => {
  assert.equal(mergeDefaults(undefined, 5), 5);
  assert.equal(mergeDefaults(undefined, 'x'), 'x');
  assert.deepEqual(mergeDefaults(undefined, { k: 1 }), { k: 1 });
  assert.deepEqual(mergeDefaults({}, { k: 1 }), { k: 1 });
});

test('类型不对（该是对象却是数组/标量）→ 保留原值，不硬塞', () => {
  // 用户把 settings 写成了数组？那不该被"修"成对象，静默改数据结构更危险。
  // 但 null/undefined 仍然按"没有"处理。
  assert.deepEqual(mergeDefaults([1, 2], { k: 1 }), [1, 2]);
  assert.equal(mergeDefaults('str', { k: 1 }), 'str');
  assert.deepEqual(mergeDefaults(null, { k: 1 }), { k: 1 });
});

test('数组整体替换，不逐项合并', () => {
  // 逐项合并数组语义不清（长度不同怎么办？顺序算谁的？），所以整体替换。
  const out = mergeDefaults({ list: [3] }, { list: [1, 2] });
  assert.deepEqual(out.list, [3]);
  const out2 = mergeDefaults({}, { list: [1, 2] });
  assert.deepEqual(out2.list, [1, 2]);
});

test('不改动输入对象（纯函数）', () => {
  const loaded = { settings: { owner: '我' } };
  const defaults = { settings: { courseDigest: { enabled: true } } };
  mergeDefaults(loaded, defaults);
  assert.deepEqual(loaded, { settings: { owner: '我' } }, '输入不能被改动');
});

test('多层嵌套也能补到底', () => {
  const out = mergeDefaults(
    { a: { b: { c: 1 } } },
    { a: { b: { c: 0, d: 2 }, e: 3 } },
  );
  assert.deepEqual(out, { a: { b: { c: 1, d: 2 }, e: 3 } });
});

test('真实场景：老库补上 courseDigest 的四个槽位', () => {
  // 模拟一份"加摘要功能之前"的库
  const old = { version: 1, settings: { owner: '我', termStart: '2026-09-21' }, events: [], courses: [] };
  const out = mergeDefaults(old, { version: 1, settings: { courseDigest: defaultDigestSettings() }, events: [] });
  assert.ok(out.settings.courseDigest, 'courseDigest 要被补上');
  assert.equal(out.settings.courseDigest.enabled, false, '默认关');
  for (const k of ['tonight', 'morning', 'noon', 'evening']) {
    assert.ok(out.settings.courseDigest.slots[k], `槽位 ${k} 要在`);
    assert.equal(out.settings.courseDigest.slots[k].on, true);
  }
  assert.equal(out.settings.owner, '我', '原有设置不能动');
});

// ⚠️ 这条是**防漂移**用的，不是测逻辑：
// 设置页「关于」那一栏原来写死 `'v0.3.0（手机可用版）'`，一路错到 0.12.0。
// 现在版本号在网页端只有 core/defaults.js 的 `APP_VERSION` 一处（有服务端时优先用
// `/api/health` 的 version），所以它必须和 package.json 的 `version` 一致。
test('版本号防漂移：APP_VERSION 必须等于 package.json 的 version', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { APP_VERSION } = await import('../core/defaults.js');
  assert.equal(APP_VERSION, pkg.version,
    `core/defaults.js 的 APP_VERSION=${APP_VERSION} 与 package.json 的 version=${pkg.version} 不一致`
    + '（发版时两处一起改，另外还有 android/app/build.gradle 的 versionName 与 ios/project.yml 的 MARKETING_VERSION）');
});

