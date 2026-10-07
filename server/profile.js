// Apple 配置描述文件（.mobileconfig）生成 —— 唯一真源。
//
// 为什么单独一个文件：
//   `/profile` 路由和 `tools/export-profile.mjs`（导出可传输的文件）**必须**产出
//   一模一样的东西。以前这段逻辑内联在 main.js 里，导出的文件和网页下载的
//   文件是两条独立代码路径，改了一边忘了另一边就会得到"网页能装、文件装不上"
//   这种极难排查的现象。抽出来之后两边共用，不可能走偏。
//
// 关于流程（踩了很久，别删注释）：
//   iOS 的「设置 → 通用 → 关于本机 → 证书信任设置」**只列出通过配置描述文件
//   安装的证书**。直接下载 `.crt` 时，Safari 有可能只把它存成"文件"（进"文件"
//   App），那种证书进的是证书信任库、**永远不会出现在那个列表里**，于是你换了
//   多少次证书内容都没用。`.mobileconfig` 是 iOS 唯一保证走"已下载描述文件 →
//   安装"流程的格式。

/**
 * 标记一段 base64 为 plist 的 **`<data>`** 类型。
 *
 * ⚠️ 这个包装是必须的，别为了"简洁"去掉：
 *   证书载荷的 `PayloadContent` 在 Apple 规范里是 **data 类型**，序列化出去必须
 *   是 `<data>BASE64</data>`。如果偷懒用 `<string>`，iOS 的报错是
 *    **「字段"PayloadContent"无效」**，然后整个描述文件装不上。
 *    实测踩过：结构看着完全正常（XML/DTD/UUID/base64 全对），就因为少了这一个
 *    标签名，装的时候直接失败。所以这里用显式包装，而不是靠"看着像 base64”。
 */
export function plistData(base64) {
  return { __plistData: String(base64) };
}

/** 把 JS 对象转成 Apple plist XML。支持字符串/布尔/数字/数组/字典/data。 */
export function toPlist(value, indent = '') {
  const pad = indent;
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // data 必须在通用 object 分支**之前**判断，否则会被当成 dict 展开
  if (value && typeof value === 'object' && typeof value.__plistData === 'string') {
    return `${pad}<data>${value.__plistData}</data>`;
  }
  if (Array.isArray(value)) {
    return `${pad}<array>\n${value.map((v) => toPlist(v, pad + '  ')).join('\n')}\n${pad}</array>`;
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([k, v]) => `${pad}  <key>${esc(k)}</key>\n${toPlist(v, pad + '  ')}`)
      .join('\n');
    return `${pad}<dict>\n${inner}\n${pad}</dict>`;
  }
  if (typeof value === 'boolean') return `${pad}<${value ? 'true' : 'false'}/>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  return `${pad}<string>${esc(value)}</string>`;
}

/**
 * 随机 UUID（v4 形状）。
 *
 * ⚠️ 为什么必须随机：固定 UUID 有个坑 —— 如果设备上已经装过同 UUID 的旧描述
 *    文件，iOS 会认为"这份已经装过了"，于是**不提示更新**（或者装上但仍是旧
 *    证书）。随机生成保证每次都是一份"新的"描述文件，设备一定会重新走安装流程。
 *
 * ⚠️ 为什么不用 `Math.random().toString(16).slice(2, 14)`：
 *    `Math.random()` 的十六进制展开**长度不定** —— `0.5` 展开就是 `"0.8"`，
 *    切出来只有 1 个字符。那样拼出的 UUID 最后一段会短于 12 位，是**畸形 UUID**
 *    （实测生成了 `BCE09DBF-…-74447D6379`，末段只有 10 位）。
 *    所以逐位取十六进制字符，长度天然固定。
 */
export function uuid() {
  const hex = (n) => Array.from(
    { length: n },
    () => Math.floor(Math.random() * 16).toString(16),
  ).join('').toUpperCase();
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

/**
 * 构造描述文件的 plist 对象。
 * @param {string} derBase64  CA 根证书的 base64（**不是** PEM，不要带 BEGIN 头）
 */
export function buildProfile(derBase64) {
  return {
    PayloadContent: [{
      PayloadCertificateFileName: 'timetable-ca.crt',
      PayloadContent: plistData(derBase64),
      PayloadDescription: '让浏览器信任本机日程表服务签发的 HTTPS 证书',
      PayloadDisplayName: 'Timetable Local CA',
      PayloadIdentifier: 'local.timetable.cert',
      PayloadType: 'com.apple.security.root',
      PayloadUUID: uuid(),
      PayloadVersion: 1,
    }],
    PayloadDisplayName: 'Timetable 本机证书',
    PayloadIdentifier: 'local.timetable.profile',
    PayloadRemovalDisallowed: false,
    PayloadType: 'Configuration',
    PayloadUUID: uuid(),
    PayloadVersion: 1,
  };
}

/** 完整的 .mobileconfig 文本（XML）。 */
export function buildMobileconfig(derBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${toPlist(buildProfile(derBase64))}
</plist>
`;
}
