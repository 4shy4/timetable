// 在「连着电脑」和「本机独立」之间切换。
//
// 为什么要单独一个模块而不是直接在设置页里 `setApiMode()`：
//   切换**不是**翻个开关那么简单 —— 必须先把远程数据**整份拷进本地库**，
//   否则用户一切过去就看到"0 条日程"，会以为数据被删了（这个应用里最吓人的症状）。
//   所以切换动作要成一个明确的、有顺序的操作，而不是散在界面里。
//
// ⚠️ 方向性说明（重要）：
//   「切到本机」= 电脑上的数据**整份复制**到本机，之后本机自己读写。
//   「切回电脑」= 只是不再用本地库；**本机上的改动不会自动推回电脑**
//                （那是 4c「增量同步」要解决的事）。所以界面上必须写清楚。

import { api, setApiMode, getApiMode } from './api.js';
import { localApi } from './api-local.js';
// 判断"在不在原生壳里" —— 决定没存过模式时的默认值（见下面 savedMode）
import { inShell } from './native.js';

const FLAG = 'timetable.mode';

/**
 * 当前模式：优先看用户上次的选择。
 *
 * ⚠️ 没存过时的默认值**取决于在不在原生壳里**：
 *    原生壳（iPad 独立 App）根本没有可连的电脑，默认 remote 会让首次打开
 *    直接显示"连不上"，用户以为坏了 → 壳里默认 local。
 *    浏览器/PWA 里默认必须是 remote —— 否则既有用户"数据凭空变空"。
 */
export function savedMode() {
  try {
    const v = localStorage.getItem(FLAG);
    if (v === 'local') return 'local';
    if (v === 'remote') return 'remote';
  } catch { /* 读不到就走下面的默认 */ }
  return inShell() ? 'local' : 'remote';
}

/** 启动时把模式恢复成用户上次选的。必须在 store.init() 之前调用 */
export function applySavedMode() {
  const m = savedMode();
  setApiMode(m);
  return m;
}

/**
 * 切到「本机独立」。
 *
 * 顺序不能反：**先**从远程整份取下来、**再**写进本地库、**最后**才切模式。
 * 反过来的话，中间任何一步失败都会留下"模式已经是 local、本地却是空的"这种状态。
 *
 * @param {{seed?: boolean}} opts seed=false 则不从电脑拷数据（想要一个干净的本机库时用）
 */
export async function switchToLocal({ seed = true } = {}) {
  if (getApiMode() === 'local') return { mode: 'local', seeded: false };

  let dump = null;
  if (seed) {
    // 此刻还是 remote 模式，所以这一步走的是服务端
    dump = await api.state();
  }

  await localApi.wipe();
  if (dump) {
    await localApi.restore({
      events: dump.events || [],
      courses: dump.courses || [],
      settings: dump.settings || {},
    });
  }

  setApiMode('local');
  try { localStorage.setItem(FLAG, 'local'); } catch { /* 存不了也不致命 */ }
  return {
    mode: 'local',
    seeded: !!dump,
    events: (dump && dump.events ? dump.events.length : 0),
    courses: (dump && dump.courses ? dump.courses.length : 0),
  };
}

/** 切回「连着电脑」。本机库保留（不删）—— 万一用户又切回来，数据还在 */
export function switchToRemote() {
  setApiMode('remote');
  try { localStorage.setItem(FLAG, 'remote'); } catch { /* ignore */ }
  return { mode: 'remote' };
}

/** 本机库里现在有什么（界面用来显示"本机 N 条日程"） */
export async function localSummary() {
  const st = await localApi.state();
  return {
    events: (st.events || []).length,
    courses: (st.courses || []).length,
    rev: st.rev || 0,
  };
}

/** 清空本机库（"我不想要本机数据了"） */
export async function wipeLocal() {
  await localApi.wipe();
  return { ok: true };
}
