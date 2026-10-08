// 极简二维码生成器（纯 JS，零依赖、平台无关）
//
// 为什么要自己写：当时环境里装不了 npm 包；而手机上"扫码即达"是最关键的体验
// （用户不会手输 192.168.x.x:7443）。二维码本身不复杂：
//   UTF-8 字节 → 数据位 + Reed-Solomon 纠错 → 按版本/掩码排布成矩阵。
//
// 平台无关：只用 TextEncoder / TextDecoder（Web、Node、安卓 WebView、iOS JavaScriptCore
// 都有），**不用 Node 的 Buffer** —— 否则 iOS 侧就跑不了。
//
// 支持范围（够用即可）：
//   模式：字节模式（URL 都是 ASCII 或 UTF-8）
//   纠错：L / M / Q / H，默认 M
//   版本：1–10（版本 10 字节模式 M 级可放 213 字节，局域网网址远远够）
//
// 出口：
//   makeQrMatrix(text, { ecl }) -> { size, modules: number[][], version, mask }
//   decodeQrMatrix(matrix)      -> string（自检用：反过来把内容读回来）
//   qrToSvg(text, opts)         -> string

const utf8Encode = (str) => Array.from(new TextEncoder().encode(String(str)));
const utf8Decode = (bytes) => new TextDecoder('utf-8').decode(Uint8Array.from(bytes));

// ---------------- GF(256) 伽罗华域 ----------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}());

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成 Reed-Solomon 纠错码字 */
function rsCodewords(data, ecLen) {
  // 生成多项式 (x - a^0)(x - a^1)...(x - a^(ecLen-1))
  let gen = [1];
  for (let i = 0; i < ecLen; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j += 1) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---------------- 版本 / 纠错参数表（版本 1–10） ----------------
// 每项：[每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]
const EC_TABLE = {
  L: [
    [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
    [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
    [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13], [22, 1, 22], [18, 2, 17], [26, 2, 24], [18, 2, 15, 2, 16],
    [24, 4, 19], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9], [28, 1, 16], [22, 2, 13], [16, 4, 9], [22, 2, 11, 2, 12],
    [28, 4, 15], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

const ALIGN_POSITIONS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const EC_LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

function ecInfo(version, ecl) {
  const row = EC_TABLE[ecl][version - 1];
  const ecPerBlock = row[0];
  const g1Blocks = row[1];
  const g1Data = row[2];
  const g2Blocks = row[3] || 0;
  const g2Data = row[4] || 0;
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data;
  const totalCodewords = totalData + ecPerBlock * (g1Blocks + g2Blocks);
  return { ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data, totalData, totalCodewords };
}

function charCountBits(version) {
  return version < 10 ? 8 : 16;
}

// ---------------- 位流 ----------------
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] || 0);
      out.push(byte);
    }
    return out;
  }
}

function pickVersion(byteLen, ecl) {
  for (let v = 1; v <= 10; v += 1) {
    const info = ecInfo(v, ecl);
    const needBits = 4 + charCountBits(v) + byteLen * 8;
    if (needBits <= info.totalData * 8) return v;
  }
  throw new Error(`内容太长，放不进二维码（${byteLen} 字节，最多支持版本 10 / ${ecl} 级）`);
}

function buildCodewords(bytes, version, ecl) {
  const info = ecInfo(version, ecl);
  const buf = new BitBuffer();
  buf.put(0b0100, 4);                       // 字节模式
  buf.put(bytes.length, charCountBits(version));
  for (const b of bytes) buf.put(b, 8);

  // 结束符 + 补齐到字节
  const capacityBits = info.totalData * 8;
  const term = Math.min(4, capacityBits - buf.length);
  if (term > 0) buf.put(0, term);
  while (buf.length % 8 !== 0) buf.put(0, 1);

  let data = buf.toBytes();
  const padBytes = [0xec, 0x11];
  let i = 0;
  while (data.length < info.totalData) {
    data.push(padBytes[i % 2]);
    i += 1;
  }

  // 分块 + 逐块算纠错
  const blocks = [];
  let offset = 0;
  for (let b = 0; b < info.g1Blocks; b += 1) {
    const chunk = data.slice(offset, offset + info.g1Data);
    offset += info.g1Data;
    blocks.push({ data: chunk, ec: rsCodewords(chunk, info.ecPerBlock) });
  }
  for (let b = 0; b < info.g2Blocks; b += 1) {
    const chunk = data.slice(offset, offset + info.g2Data);
    offset += info.g2Data;
    blocks.push({ data: chunk, ec: rsCodewords(chunk, info.ecPerBlock) });
  }

  // 交错：先按列取数据码字，再按列取纠错码字
  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  }
  for (let i = 0; i < info.ecPerBlock; i += 1) {
    for (const b of blocks) result.push(b.ec[i]);
  }
  return result;
}

// ---------------- 矩阵排布 ----------------
function emptyMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r; const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = inRing || inCore ? 1 : 0;
    }
  }
}

function placeAlignment(m, version) {
  const pos = ALIGN_POSITIONS[version - 1] || [];
  for (const r of pos) {
    for (const c of pos) {
      // 跳过与定位图形重叠的位置
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          m[r + dr][c + dc] = isEdge || isCenter ? 1 : 0;
        }
      }
    }
  }
}

function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = bit;
    if (m[i][6] === null) m[i][6] = bit;
  }
}

function reserveFormatAreas(m) {
  const size = m.length;
  // 格式信息区域先占位（值为 null 会被当空位用来放数据，必须先标记）
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1; // 固定黑点
}

function placeData(m, codewords) {
  const size = m.length;
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((cw >>> i) & 1);
  }
  let idx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // 跳过竖直定时图案列
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        m[row][c] = idx < bits.length ? bits[idx] : 0;
        idx += 1;
      }
    }
    upward = !upward;
  }
}

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, maskId, reserved) {
  const size = m.length;
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved[r][c]) continue;
      if (MASK_FN[maskId](r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  // 规则 1：同色连排
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (m[r][c] === m[r][c - 1]) run += 1; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (m[r][c] === m[r - 1][c]) run += 1; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // 规则 3：类似定位图形的 1011101 0000 组合
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (get, len, start, pat) => {
    for (let i = 0; i < pat.length; i += 1) if (get(start + i) !== pat[i]) return false;
    return true;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + pat1.length <= size; c += 1) {
      if (matchAt((i) => m[r][i], size, c, pat1) || matchAt((i) => m[r][i], size, c, pat2)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r + pat1.length <= size; r += 1) {
      if (matchAt((i) => m[i][c], size, r, pat1) || matchAt((i) => m[i][c], size, r, pat2)) score += 40;
    }
  }
  // 规则 4：黑白比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** 格式信息：BCH(15,5) + 固定掩码 0x5412 */
function formatBits(ecl, maskId) {
  const data = (EC_LEVEL_BITS[ecl] << 3) | maskId;
  let value = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >>> i) & 1) value ^= gen << (i - 10);
  }
  return (((data << 10) | value) ^ 0b101010000010010) & 0x7fff;
}

function placeFormat(m, ecl, maskId) {
  const size = m.length;
  const bits = formatBits(ecl, maskId);
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >>> i) & 1;
    // 左上角这一份：第 0–8 位落在**第 8 列**（竖着排），第 8–14 位落在**第 8 行**（横着排）。
    //
    // ⚠️ 这里曾经写反过（行/列对调），后果是**码看着完全正常、我们自己也能读回来，
    //    但真手机/OpenCV 一律扫不出来** —— 因为格式信息（纠错等级 + 掩码号）
    //    被放在了对称的位置上。自检解码器和编码器共享了同一个错误假设，所以内部一路绿灯。
    //    教训：凡是"两个实现互相验"的场合，必须有一个**外部**参照
    //    （这里是 build/qr-control.py：拿 Python qrcode 库 / OpenCV 对表）。
    if (i < 6) m[i][8] = bit;
    else if (i === 6) m[7][8] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
    // 副本（同样别把行列弄反：0–7 位在**行 8** 的右端，8–14 位在**列 8** 的下端）
    if (i < 8) m[8][size - 1 - i] = bit;
    else m[size - 15 + i][8] = bit;
  }
  m[size - 8][8] = 1;
}

function versionBits(version) {
  let value = version << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if ((value >>> i) & 1) value ^= gen << (i - 12);
  }
  return ((version << 12) | value) & 0x3ffff;
}

function placeVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

/**
 * 生成二维码矩阵。
 * @param {string} text
 * @param {{ecl?: 'L'|'M'|'Q'|'H', mask?: number}} opts
 *   `mask` 是**测试用**的逃生口：给 0–7 就跳过"挑最优掩码"直接用这一个。
 *   掩码选择只是"哪个更耐脏"的启发式，8 个掩码都是合法码；要拿别的实现当参照
 *   逐格比对时，必须先把掩码钉死，否则比出来的是两套打分算法的差异，不是对错。
 * @returns {{size:number, modules:number[][], version:number, mask:number, ecl:string}}
 */
export function makeQrMatrix(text, opts = {}) {
  const ecl = opts.ecl || 'M';
  const forcedMask = Number.isInteger(opts.mask) ? opts.mask : null;
  const bytes = utf8Encode(text);
  const version = pickVersion(bytes.length, ecl);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, ecl);

  const base = emptyMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTiming(base);
  reserveFormatAreas(base);
  placeVersion(base, version);

  const reserved = base.map((row) => row.map((v) => v !== null));
  placeData(base, codewords);

  let best = null;
  for (let maskId = 0; maskId < 8; maskId += 1) {
    if (forcedMask != null && maskId !== forcedMask) continue;
    const candidate = applyMask(base, maskId, reserved);
    placeFormat(candidate, ecl, maskId);
    placeVersion(candidate, version);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate, mask: maskId };
  }

  return { size, modules: best.matrix, version, mask: best.mask, ecl };
}

/** 渲染成 SVG（服务端直接吐给浏览器，不用前端再画） */
export function qrToSvg(text, opts = {}) {
  const { size, modules } = makeQrMatrix(text, opts);
  const quiet = opts.quiet == null ? 2 : opts.quiet;
  const total = size + quiet * 2;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="100%" height="100%" shape-rendering="crispEdges">`];
  parts.push(`<rect width="${total}" height="${total}" fill="#ffffff"/>`);
  parts.push('<path fill="#000000" d="');
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  parts.push('"/></svg>');
  return parts.join('');
}

// ---------------- 自检用解码器 ----------------
// 目的是验证"生成的码真的能被读回来"，而不是只检查它看起来像二维码。

function readFormat(m) {
  const size = m.length;
  let bits = 0;
  for (let i = 14; i >= 0; i -= 1) {
    let bit;
    // 必须与 placeFormat() 一一对应（见那里的注释：行/列曾经对调过）
    if (i < 6) bit = m[i][8];
    else if (i === 6) bit = m[7][8];
    else if (i === 7) bit = m[8][8];
    else if (i === 8) bit = m[8][7];
    else bit = m[8][14 - i];
    bits = (bits << 1) | bit;
  }
  const unmasked = bits ^ 0b101010000010010;
  const data = (unmasked >>> 10) & 0b11111;
  const eclBits = (data >>> 3) & 0b11;
  const mask = data & 0b111;
  const eclName = Object.entries(EC_LEVEL_BITS).find(([, v]) => v === eclBits);
  return { ecl: eclName ? eclName[0] : 'M', mask, size };
}

/** 从矩阵把内容读回来（支持版本 1–10、字节模式） */
export function decodeQrMatrix(matrix) {
  const m = matrix.map((row) => row.slice());
  const size = m.length;
  const { ecl, mask } = readFormat(m);

  // 重建功能图形占位，才能正确还原掩码
  const base = emptyMatrix(size);
  const version = (size - 17) / 4;
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTiming(base);
  reserveFormatAreas(base);
  placeVersion(base, version);
  const reserved = base.map((row) => row.map((v) => v !== null));

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!reserved[r][c] && MASK_FN[mask](r, c)) m[r][c] ^= 1;
    }
  }

  // 按 zigzag 顺序读回码字
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(m[row][c]);
      }
    }
    upward = !upward;
  }

  const stream = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
    stream.push(b);
  }

  // 反交错，取回数据码字
  const info = ecInfo(version, ecl);
  const blockSizes = [];
  for (let i = 0; i < info.g1Blocks; i += 1) blockSizes.push(info.g1Data);
  for (let i = 0; i < info.g2Blocks; i += 1) blockSizes.push(info.g2Data);
  const blocks = blockSizes.map(() => []);
  const maxData = Math.max(...blockSizes);
  let idx = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < blockSizes[b]) { blocks[b].push(stream[idx]); idx += 1; }
    }
  }
  const data = [].concat(...blocks);

  // 读模式与长度，再取内容
  let bitPos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) { v = (v << 1) | ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1); bitPos += 1; }
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`解码失败：模式不是字节模式（${mode.toString(2)}）`);
  const len = take(charCountBits(version));
  const bytes = [];
  for (let i = 0; i < len; i += 1) bytes.push(take(8));
  return utf8Decode(bytes);
}
