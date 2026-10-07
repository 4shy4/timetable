// 帮助：提醒方案说明 + 使用指南（同时也是设计文档的入口）
import { el, mount } from '../dom.js';

export const helpView = {
  id: 'help',
  label: '帮助',
  icon: '?',

  title() { return '帮助'; },
  subtitle() { return '提醒方案 · 快捷键 · 常见问题'; },
  nav() { return []; },
  onNav() {},

  render(state, ctx, host) {
    mount(host, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '900px' } }, [
      el('div.card.panel', {}, [
        el('h2', { text: '气泡面板怎么看' }),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' } }, [
          el('div', {}, [
            el('b', { text: '大小 = 事情多大（你说了算）' }),
            el('p', {
              text: '在工具栏选中气泡后拖滑动条，或点预设（小事 / 要紧 / 头等大事）。大小只跟"这事有多大"有关，跟时间无关——不急的大事也是大气泡。已完成的气泡缩一半让位。',
              style: { color: 'var(--muted)', marginTop: '3px' },
            }),
          ]),
          el('div', {}, [
            // ⚠️ 这一节以前写的是"颜色 = 紧急程度（自动变）"，那是**过时的**：
            //    core/level.js 里已经明确写着"颜色已经不代表紧急度了" ——
            //    颜色改成由用户自己选（编辑器的「事情多大」），只表示层级/套娃。
            //    文案没跟着改是个真实疏漏，用户照着旧说明会完全理解错。
            el('b', { text: '颜色 = 事情多大（你自己选）' }),
            el('p', {
              text: '在编辑器的「事情多大（决定气泡颜色）」里选：蓝 → 绿 → 黄 → 红。'
                + '它决定气泡颜色，以及「谁能放进谁里面」（大容器里只能放更小的东西）。'
                + '注意：颜色跟时间无关，不急的大事也可以是红色。',
              style: { color: 'var(--muted)', marginTop: '3px' },
            }),
          ]),
          el('div', {}, [
            el('b', { text: '提醒强度 = 按"还剩多久"自动升级' }),
            el('p', {
              text: '周/月/年 → 1 档；进入「日」→ 2 档；进入「小时」→ 3 档；'
                + '最后 1 小时内或已经过期 → 4 档（最强）。跟气泡颜色无关。'
                + '设置页里可以改成「强制某一档」，那会对所有提醒一起生效。',
              style: { color: 'var(--muted)', marginTop: '3px' },
            }),
          ]),
          el('div', {}, [
            el('b', { text: '最强档在 iPad 上可以响成"真闹钟"' }),
            el('p', {
              text: '给某条日程勾上「到点用真闹钟」，它最后关头的提醒就会响成系统级闹钟：'
                + '满音量、无视静音开关、锁屏全屏、要手动按掉。'
                + '代价是真闹钟会穿过专注模式（系统就是这么设计的，App 改不了），'
                + '所以只勾「绝对不能错过」的事。没勾的日程永远不会这样。',
              style: { color: 'var(--muted)', marginTop: '3px' },
            }),
          ]),
          el('div', {}, [
            el('b', { text: '怎么操作' }),
            el('ul', { style: { color: 'var(--muted)', marginTop: '3px', display: 'flex', flexDirection: 'column', gap: '3px' } }, [
              el('li', { text: '拖动：把挡路的气泡挪开（松手有惯性，气泡会弹性形变一下）' }),
              el('li', { text: '单击：选中它（然后就可用滑动条调大小）' }),
              el('li', { text: '双击：标记完成 / 恢复' }),
              el('li', { text: '双击空白处：新建日程' }),
              el('li', { text: '工具栏：换时间范围 / 重排 / 暂停漂浮' }),
            ]),
          ]),
          el('p.tiny', { text: '配色依据、漂浮与碰撞的公式详见 docs/BUBBLE-DESIGN.md。' }),
        ]),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '四套提醒方案（当前已启用 A / B / D）' }),
        el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } }, [
          el('thead', {}, [el('tr', {}, ['方案', '机制', '页面关掉后', '状态'].map((t) =>
            el('th', { text: t, style: { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontWeight: '600' } })))]),
          el('tbody', {}, [
            row('A · 浏览器通知', '页面内每秒核对提醒点，命中即弹系统通知', '❌ 失效', '✅ 已启用'),
            row('B · 后台服务提醒', '服务端每 20 秒扫描，通过 Windows 通知中心弹出', '✅ 照常提醒', '✅ 已启用'),
            row('C · PWA 推送', 'Service Worker + Web Push，手机锁屏也能收', '✅ 照常提醒', '⏳ 待联网'),
            row('D · 开机自启', '登录后在后台静默启动服务', '—', '✅ 可开关'),
          ]),
        ]),
        el('p.tiny', { text: '方案 C 需要 https 域名 + 推送服务器，等网络可用后再接。详见 docs/DESIGN.md 第 4 节。' }),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '常用操作' }),
        el('ul', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' } }, [
          li('新建日程：点月历格子 / 时间轴空白处，或按', 'N'),
          // ⚠️ 这一条要写清楚"是解析 + 让你确认"，不能写成"自动帮你加" ——
          //    否则用户会以为它听懂了一切，然后被猜错的结果坑到。
          li('一句话加日程：左侧「✍️ 一句话加日程」或按', 'K', '，说「明天下午3点 在图书馆 交作业 提前20分钟」'),
          li('Siri / 快捷指令：做一个快捷指令「听写文本 → 打开 URL timetable://add?text=…」，口令自定'),
          li('气泡面板：单击编辑、双击完成、拖动挪位'),
          li('编辑日程：点任意色块、方块或清单条目'),
          li('标记完成：清单页点左侧圆圈，或双击气泡'),
          li('翻页：', '← →', '方向键，或点标题两侧的箭头'),
          li('导入课表：左侧「导入课表」→ 粘贴 JSON 或载入示例 → 校验 → 导入'),
          li('切换视图：', '1 2 4 5', ' 分别对应气泡 / 月历 / 清单 / 课程表'),
        ]),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '常见问题' }),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' } }, [
          qa('没有收到系统通知？',
            '① 设置页点「发送一条测试通知」看是否弹出；② Windows 设置 → 系统 → 通知，确认允许应用通知且未开启「专注助手」；③ 查看 data/server.log 是否有 scheduler 触发记录。'),
          qa('两台设备数据不一样？',
            '当前是本地存储：每台设备各自一份数据。手机与电脑要同步，需要后续的云同步版本。同一局域网内手机访问电脑地址时，看到的是电脑的数据。'),
          qa('手机上怎么用？',
            '用 npm run start:lan 启动服务，再用手机浏览器打开打印出来的 http://192.168.x.x:7080 地址；然后「添加到主屏幕」，就像 App 一样。注意此时通知权限需要 https 才能完全放开，安卓 Chrome 对局域网 http 可能限制通知。'),
          qa('数据会丢吗？',
            '每次写入都会先写临时文件再原子替换，断电不会写坏；同时浏览器有一份缓存镜像。建议偶尔在设置页下载一次备份。'),
        ]),
      ]),
    ]));
  },
};

function row(a, b, c, d) {
  const cell = { padding: '8px 6px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
  return el('tr', {}, [
    el('td', { text: a, style: { ...cell, fontWeight: '600', whiteSpace: 'nowrap' } }),
    el('td', { text: b, style: cell }),
    el('td', { text: c, style: { ...cell, whiteSpace: 'nowrap' } }),
    el('td', { text: d, style: { ...cell, whiteSpace: 'nowrap' } }),
  ]);
}

function li(text, kbd, tail = '') {
  return el('li', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, [
    text, kbd ? el('span.kbd', { text: kbd }) : null, tail,
  ]);
}

function qa(q, a) {
  return el('div', {}, [
    el('b', { text: 'Q：' + q }),
    el('p', { text: 'A：' + a, style: { color: 'var(--muted)', marginTop: '4px' } }),
  ]);
}
