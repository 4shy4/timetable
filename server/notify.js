// 通知适配器：把「该提醒了」这件事送到不同通道。
// 新增通道只需在这里加一个 adapter，并在 dispatch 里挂上。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.js';

const APP_ID = 'Timetable.Desktop';

export const adapters = {
  /** 通道 1：控制台（永远可用，调试与兜底） */
  console: async (msg) => {
    console.log(`\n[提醒] ${msg.title}\n       ${msg.body}\n`);
  },

  /**
   * 通道 2：Windows 原生通知中心 Toast。
   * 通过 PowerShell 调用 WinRT，不需要安装任何模块。
   * 强度（提示音、停留时长、是否必看）随紧急档位传入。
   */
  windows: async (msg) => {
    const script = path.join(ROOT, 'tools', 'toast.ps1');
    const args = [
      msg.title,
      msg.body,
      String(msg.eventId || ''),
      String(msg.audio || ''),
      String(msg.durationMs || 8000),
      msg.requireInteraction ? '1' : '0',
    ];
    return runPowerShell(script, args);
  },

  /** 通道 3：空实现占位——Web Push / 邮件 / 微信 webhook 未来的位置 */
  web: async () => ({ ok: true, note: '由浏览器端提醒引擎负责，服务端不重复推送' }),
};

function runPowerShell(script, args) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, ...args,
    ], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => resolve({ ok: false, error: e.message }));
    ps.on('close', (code) => resolve(
      code === 0 ? { ok: true } : { ok: false, code, error: err.slice(0, 400) },
    ));
  });
}

let lastWindowsAttempt = 0;
let windowsAvailable = true;

/**
 * 按设置的开关把提醒发到所有允许的通道。
 * 单通道失败不影响其它通道。
 */
export async function dispatch(msg, channels) {
  const list = channels || ['console'];
  const results = {};
  for (const name of list) {
    const fn = adapters[name];
    if (!fn) { results[name] = { ok: false, error: '未知通道' }; continue; }
    // Windows Toast 连续失败两次就停用，避免每次提醒都卡一下
    if (name === 'windows') {
      if (!windowsAvailable) { results[name] = { ok: false, error: '已临时停用' }; continue; }
      if (Date.now() - lastWindowsAttempt < 1000) { results[name] = { ok: false, error: '限流' }; continue; }
      lastWindowsAttempt = Date.now();
    }
    try {
      const r = await fn(msg);
      results[name] = r;
      if (name === 'windows' && !r.ok) windowsAvailable = false;
    } catch (err) {
      results[name] = { ok: false, error: err.message };
      if (name === 'windows') windowsAvailable = false;
    }
  }
  return results;
}

/** 服务端实际启用的通道（受 settings.notify 控制） */
export function activeChannels() {
  return ['console', 'windows'];
}

export { APP_ID };
