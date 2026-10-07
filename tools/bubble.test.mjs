// 配色、尺寸映射、通知强度的单元测试。
// v0.4 起：**大小 = 还剩多久**、**颜色 = 事情多大**，两条通道互不影响。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  URGENCY_TIERS, tierForHours, tierByKey, tierColor, tierFill, tierTextColor,
  radiusForMagnitude, migrateImportance, luminance,
  radiusRangeForCanvas, areaScaleForCanvas, RADIUS_MIN_FLOOR,
  MAGNITUDE_MIN, MAGNITUDE_MAX, RADIUS_MIN, RADIUS_MAX,
} from '../core/palette.js';
import {
  urgencyOf, bubbleStyle, describeTimeLeft,
  defaultMagnitudeForType, notifyStyleForIntensity, reminderPlanForBand,
} from '../core/urgency.js';

// ---------------------------------------------------------------------------
// 四档语义色
// ---------------------------------------------------------------------------

test('恰好四档，且顺序就是从"还早"到"紧急"', () => {
  assert.equal(URGENCY_TIERS.length, 4);
  assert.deepEqual(URGENCY_TIERS.map((t) => t.key), ['sky', 'emerald', 'amber', 'red']);
  assert.deepEqual(URGENCY_TIERS.map((t) => t.intensity), [1, 2, 3, 4]);
});

test('颜色符合要求的语义：天蓝 / 翠绿 / 黄 / 红', () => {
  assert.equal(tierColor('sky'), '#38bdf8');
  assert.equal(tierColor('emerald'), '#22c55e');
  assert.equal(tierColor('amber'), '#f5b301');
  assert.equal(tierColor('red'), '#ef4444');
});

test('四个颜色互不相同，且都是合法十六进制', () => {
  const colors = URGENCY_TIERS.map((t) => t.color);
  assert.equal(new Set(colors).size, 4);
  for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('色相确实是"蓝→绿→黄→红"（防止有人改错颜色顺序）', () => {
  const hue = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const h = Object.fromEntries(URGENCY_TIERS.map((t) => [t.key, hue(t.color)]));
  assert.ok(h.sky > 180 && h.sky < 220, `天蓝应在 180–220，实际 ${h.sky}`);
  assert.ok(h.emerald > 90 && h.emerald < 160, `翠绿应在 90–160，实际 ${h.emerald}`);
  assert.ok(h.amber > 30 && h.amber < 60, `黄应在 30–60，实际 ${h.amber}`);
  assert.ok(h.red < 15 || h.red > 345, `红应在 0 附近，实际 ${h.red}`);
});

test('紧迫度分档边界：6 小时 / 1 天 / 3 天', () => {
  assert.equal(tierForHours(100).key, 'sky');
  assert.equal(tierForHours(72).key, 'emerald');
  assert.equal(tierForHours(48).key, 'emerald');
  assert.equal(tierForHours(24).key, 'amber');
  assert.equal(tierForHours(6).key, 'red');
  assert.equal(tierForHours(0.1).key, 'red');
  assert.equal(tierForHours(-5).key, 'red', '已经开始的必须是最紧急');
  assert.equal(tierForHours(Number.POSITIVE_INFINITY).key, 'sky');
});

test('深色底自动用白字（对比度）', () => {
  assert.equal(tierTextColor('red'), '#ffffff');
  assert.equal(tierTextColor('emerald'), '#ffffff');
  assert.equal(tierTextColor('sky'), '#ffffff');
});

test('未知档位名回落到最不急，不崩', () => {
  assert.equal(tierByKey('nope').key, 'sky');
  assert.equal(tierColor(undefined), tierColor('sky'));
});

test('填充色是合法 rgba', () => {
  assert.match(tierFill('amber', 0.5), /^rgba\(\d+, \d+, \d+, 0\.5\)$/);
});

// ---------------------------------------------------------------------------
// 大小通道：连续滑动条
// ---------------------------------------------------------------------------

test('事情多大是连续值 1–100，不再是 5 档', () => {
  assert.equal(MAGNITUDE_MIN, 1);
  assert.equal(MAGNITUDE_MAX, 100);
  const radii = [1, 20, 40, 60, 80, 100].map((m) => radiusForMagnitude(m));
  for (let i = 1; i < radii.length; i += 1) {
    assert.ok(radii[i] > radii[i - 1], `越大半径应越大：${radii[i - 1]} -> ${radii[i]}`);
  }
  // 中间值也必须是连续的（不能只有几档）
  const a = radiusForMagnitude(50);
  const b = radiusForMagnitude(51);
  assert.ok(b > a, '相邻整数应产生不同半径（连续可调）');
});

test('半径落在设定区间内', () => {
  assert.equal(radiusForMagnitude(MAGNITUDE_MIN), RADIUS_MIN);
  assert.equal(radiusForMagnitude(MAGNITUDE_MAX), RADIUS_MAX);
  assert.equal(radiusForMagnitude(-50), RADIUS_MIN);
  assert.equal(radiusForMagnitude(9999), RADIUS_MAX);
});

// ---------------------------------------------------------------------------
// 响应式尺寸
// 真机实测：vivo 浏览器里手机画布只有约 332×370 CSS 像素。固定上限 104 会让
// 最大气泡直径占到屏宽 63%，几个气泡必然挤成一团，还会被画布边缘裁掉。
// ---------------------------------------------------------------------------

test('手机尺寸下最大半径跟着画布缩，而不是沿用桌面的 104', () => {
  const phone = radiusRangeForCanvas(332, 370);
  // 上限 = 短边 370 × 22% ≈ 81，且不超过桌面上限
  assert.ok(phone.max <= 370 * 0.23, `手机最大半径应受短边约束：${phone.max}`);
  assert.ok(phone.max < RADIUS_MAX, `应小于桌面上限 ${RADIUS_MAX}，实际 ${phone.max}`);
  assert.ok(phone.max >= 30, `但也不能小到看不见：${phone.max}`);
  assert.ok(phone.min >= RADIUS_MIN_FLOOR, '最小半径有下限，保证文字还读得出');
  assert.ok(phone.min < phone.max, '区间必须有效');
});

test('桌面尺寸下保持原来的上限', () => {
  const desk = radiusRangeForCanvas(1400, 820);
  assert.equal(desk.max, RADIUS_MAX, '大屏不应被缩小');
  assert.equal(desk.min, RADIUS_MIN);
});

test('画布越大，允许的最大气泡越大（单调）', () => {
  const sizes = [[300, 400], [500, 600], [900, 800], [1600, 900]];
  const maxes = sizes.map(([w, h]) => radiusRangeForCanvas(w, h).max);
  for (let i = 1; i < maxes.length; i += 1) {
    assert.ok(maxes[i] >= maxes[i - 1], `画布变大时上限不该变小：${maxes[i - 1]} -> ${maxes[i]}`);
  }
});

test('手机画布下最宽的气泡不超过屏宽的 45%', () => {
  const phone = radiusRangeForCanvas(332, 370);
  assert.ok(phone.max * 2 <= 332 * 0.45, `最宽气泡 ${phone.max * 2}px 相对 332px 画布太宽`);
});

test('气泡太多时整体缩小，避免糊成一团', () => {
  const radii = Array.from({ length: 8 }, () => 60);
  const scaled = areaScaleForCanvas(radii, 332, 370);
  assert.ok(scaled < 1, `8 个 r=60 的气泡在手机画布上应被缩小，实际 scale=${scaled}`);
  assert.ok(scaled >= 0.42, '缩放有下限，不能缩到看不见');
  const total = radii.reduce((s, r) => s + Math.PI * (r * scaled) ** 2, 0);
  assert.ok(total <= 332 * 370 * 0.45, '缩小后总面积应落回预算内');
});

test('气泡很少时不缩放，尺寸未知也不崩', () => {
  assert.equal(areaScaleForCanvas([40, 40], 332, 370), 1);
  assert.equal(areaScaleForCanvas([], 332, 370), 1);
  assert.equal(areaScaleForCanvas([40], 0, 0), 1);
});

test('旧数据 importance(1–5) 自动换算到 1–100，不丢信息', () => {
  assert.equal(migrateImportance(1), 20);
  assert.equal(migrateImportance(3), 60);
  assert.equal(migrateImportance(5), 100);
  assert.equal(migrateImportance(70), 70, '已经是新格式的保持原样');
  assert.equal(migrateImportance(undefined), 50);
});

test('类型 → 默认颜色：考试最大、日常最小', () => {
  assert.equal(defaultMagnitudeForType('exam'), 100);      // red
  assert.equal(defaultMagnitudeForType('task'), 67);       // amber
  assert.equal(defaultMagnitudeForType('personal'), 1);    // sky
  assert.equal(defaultMagnitudeForType('不存在'), 1);
});

// ---------------------------------------------------------------------------
// bubbleStyle：v0.4 起 **大小 = 还剩多久**、**颜色 = 事情多大**，两者彻底独立
// ---------------------------------------------------------------------------

test('气泡大小只由"还剩多久"决定，与颜色无关', () => {
  const now = new Date('2026-03-02T12:00:00');
  // 注意：start 要放在 **event 里面**（bubbleStyle 读的是 event.start，
  // 因为截止时间可以独立于开始时间，见 core/urgency.js 的 deadlineMsOf）
  const at = (hours, level) => bubbleStyle(
    { event: { title: 'x', level, done: false, start: new Date(now.getTime() + hours * 3_600_000) } },
    { now },
  );
  // 同一时间点、不同颜色 → 半径完全一样
  assert.equal(at(0.5, 'sky').radius, at(0.5, 'red').radius,
    '颜色不该影响大小');
  // 同一颜色、不同时间 → 越近越大
  assert.ok(at(0.5, 'red').radius > at(20 * 24, 'red').radius,
    '越接近截止，气泡越大');
  // 尺寸比例单调
  assert.ok(at(2, 'sky').radiusRatio > at(48, 'sky').radiusRatio);
  assert.ok(at(48, 'sky').radiusRatio > at(24 * 100, 'sky').radiusRatio);
});

test('气泡颜色只由"事情多大"决定，与时间无关', () => {
  const now = new Date('2026-03-02T12:00:00');
  const at = (hours, level) => bubbleStyle(
    { event: { title: 'x', level, done: false, start: new Date(now.getTime() + hours * 3_600_000) } },
    { now },
  );
  for (const lv of ['sky', 'emerald', 'amber', 'red']) {
    assert.equal(at(2, lv).levelKey, lv, '很近也不该改变颜色');
    assert.equal(at(24 * 200, lv).levelKey, lv, '很远也不该改变颜色');
  }
});

test('通知强度只由"还剩多久"决定，与颜色无关', () => {
  const now = new Date('2026-03-02T12:00:00');
  const at = (hours, level) => bubbleStyle(
    { event: { title: 'x', level, done: false, start: new Date(now.getTime() + hours * 3_600_000) } },
    { now },
  );
  assert.equal(at(0.5, 'sky').intensity, at(0.5, 'red').intensity);
  assert.ok(at(0.5, 'sky').intensity > at(24 * 100, 'sky').intensity);
  assert.equal(at(0.5, 'sky').intensity, 4);
});

test('剩余时间文本：正常 / 已过期 / 未设期限', () => {
  const now = new Date('2026-03-02T12:00:00');
  const mk = (hours) => bubbleStyle(
    { event: { title: 'x', level: 'sky', start: new Date(now.getTime() + hours * 3_600_000) } },
    { now },
  );
  assert.match(mk(0.5).countdownText, /剩余 30 分/);
  assert.match(mk(-2).countdownText, /已过 2 小时/);
  assert.equal(mk(-2).overdue, true);
  assert.equal(mk(2).overdue, false);
  // 没有截止时间
  const none = bubbleStyle({ event: { title: 'n', level: 'sky' } }, { now });
  assert.equal(none.countdownText, '未设期限');
  assert.equal(none.remaining, null);
  assert.ok(none.radiusRatio > 0.05 && none.radiusRatio < 0.5, '未设期限用中性偏小的尺寸');
});

test('旧事件没有 level 时用 importance 换算，颜色不会丢', () => {
  const now = new Date('2026-03-02T12:00:00');
  const s = bubbleStyle(
    { event: { title: 'old', importance: 5, done: false, start: new Date(now.getTime() + 3_600_000) } },
    { now },
  );
  assert.equal(s.levelKey, 'red');
  assert.equal(s.magnitude, 100);
});

test('已完成的气泡明显变小', () => {
  const now = new Date('2026-03-02T12:00:00');
  const start = new Date(now.getTime() + 3_600_000);
  const a = bubbleStyle({ event: { title: 'x', level: 'amber', done: false, start } }, { now });
  const b = bubbleStyle({ event: { title: 'x', level: 'amber', done: true, start } }, { now });
  assert.ok(b.radius < a.radius * 0.6);
});

// ---------------------------------------------------------------------------
// 通知强度：v0.4 起由**还剩多久**决定（不再按颜色）
// ---------------------------------------------------------------------------

test('通知强度随强度值逐级加强', () => {
  const levels = [1, 2, 3, 4].map((i) => notifyStyleForIntensity(i).intensity);
  assert.deepEqual(levels, [1, 2, 3, 4]);

  const durs = [1, 2, 3, 4].map((i) => notifyStyleForIntensity(i).durationMs);
  for (let i = 1; i < durs.length; i += 1) {
    assert.ok(durs[i] > durs[i - 1], `停留时长应递增：${durs[i - 1]} -> ${durs[i]}`);
  }
});

test('只有最高强度"必看"且带重复', () => {
  assert.equal(notifyStyleForIntensity(1).requireInteraction, false);
  assert.equal(notifyStyleForIntensity(3).requireInteraction, false);
  assert.equal(notifyStyleForIntensity(4).requireInteraction, true);
  assert.ok(notifyStyleForIntensity(4).repeats > 0);
});

test('提醒计划随剩余时间档位加密，临近时会出现"截止后追问"', () => {
  const counts = ['year', 'day', 'hour', 'second'].map((b) => reminderPlanForBand(b).length);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] >= counts[i - 1], `提醒次数不应减少：${counts[i - 1]} -> ${counts[i]}`);
  }
  assert.ok(counts[3] > counts[0], '最紧迫的档应比最远的档提醒更多次');
  assert.ok(reminderPlanForBand('hour').some((m) => m < 0), '临近档应有"截止后"的追问');
  assert.ok(!reminderPlanForBand('year').some((m) => m < 0), '还早就不该追问');
});

test('提醒计划去重且按"提前量从大到小"排序', () => {
  for (const b of ['year', 'month', 'week', 'day', 'hour', 'minute', 'second']) {
    const plan = reminderPlanForBand(b);
    assert.equal(new Set(plan).size, plan.length, `${b} 有重复项`);
    for (let i = 1; i < plan.length; i += 1) {
      assert.ok(plan[i] <= plan[i - 1], `${b} 顺序不对：${plan}`);
    }
  }
});

test('文案：剩余时间的描述人话', () => {
  assert.match(describeTimeLeft(0.5), /分钟后/);
  assert.match(describeTimeLeft(5), /小时后/);
  assert.match(describeTimeLeft(72), /天后/);
  assert.match(describeTimeLeft(-2), /已过/);
});

test('urgencyOf 只返回排序用的连续分数（不再管颜色）', () => {
  const now = new Date('2026-03-02T12:00:00');
  let prev = -1;
  // 从远到近：分数单调不减（还未过期的那段）
  for (const h of [200, 72, 24, 6, 1, 0.2]) {
    const start = new Date(now.getTime() + h * 3_600_000);
    const s = urgencyOf(start, now).score;
    assert.ok(s >= 0 && s <= 1, `h=${h} 分数越界：${s}`);
    assert.ok(s >= prev - 1e-9, `h=${h} 应比更远的更紧迫：${prev} -> ${s}`);
    prev = s;
  }
  // 已过期：固定给一个很高的分数（"最需要被看见"），但不需要再比"刚要过期"更高
  for (const h of [-3, -48, -720]) {
    const s = urgencyOf(new Date(now.getTime() + h * 3_600_000), now).score;
    assert.ok(s >= 0.9, `已过期 h=${h} 的分数应当很高（实际 ${s}）`);
  }
});
