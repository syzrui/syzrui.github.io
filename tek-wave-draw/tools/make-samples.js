/*
 * 从原始 20MB/通道 的 ISF 生成站点自带的示例数据（50:1 抽取，约 400KB/通道）。
 * 用法：node tools/make-samples.js
 */
const fs = require('fs');
const path = require('path');
const TekISF = require('../js/isf-parser.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'samples');
const SRC = [
  ['tek0000CH1(1).isf', 'CH1.isf'],
  ['tek0000CH2(1).isf', 'CH2.isf'],
  ['tek0000CH3(1).isf', 'CH3.isf'],
  ['tek0000CH4(1).isf', 'CH4.isf']
];
const DECIMATE = 50;

function bigEndianInt16(values) {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) buf.writeInt16BE(values[i], i * 2);
  return buf;
}

function build(parsed, step) {
  const out = [];
  for (let i = 0; i < parsed.sampleCount; i += step) out.push(parsed.raw[i]);
  const data = bigEndianInt16(Int16Array.from(out));
  const n = out.length;
  const xincr = parsed.xIncrement * step;
  const digits = String(data.length).length;
  const header = [
    ':WFMPRE:NR_PT ' + n,
    ':WFMPRE:BYT_NR 2',
    'BIT_NR 16',
    'ENCDG BINARY',
    'BN_FMT RI',
    'BYT_OR MSB',
    'WFID "' + parsed.wfid.replace('10000000 points', n + ' points') + '"',
    'NR_PT ' + n,
    'PT_FMT Y',
    'XUNIT "s"',
    'XINCR ' + xincr.toExponential(4),
    'XZERO ' + parsed.xZero.toExponential(4),
    'PT_OFF ' + parsed.ptOff,
    'YUNIT "' + parsed.yUnit + '"',
    'YMULT ' + parsed.yMult.toExponential(6),
    'YOFF ' + parsed.yOff.toExponential(1),
    'YZERO ' + parsed.yZero.toExponential(1),
    'VSCALE ' + parsed.vScale,
    'HSCALE ' + parsed.hScale.toExponential(4),
    'VPOS ' + parsed.vPos,
    'VOFFSET ' + parsed.vOffset,
    'HDELAY ' + parsed.hDelay.toExponential(4),
    'DOMAIN TIME',
    'WFMTYPE ANALOG'
  ].join(';') + ';:CURVE #' + digits + String(data.length).padStart(digits, '0');
  return Buffer.concat([Buffer.from(header, 'latin1'), data]);
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

for (const [src, dst] of SRC) {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) { console.warn('缺少源文件：' + src); continue; }
  const buf = fs.readFileSync(file);
  const parsed = TekISF.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), src);
  const result = build(parsed, DECIMATE);
  fs.writeFileSync(path.join(OUT, dst), result);

  // 自检：重新解析生成的示例，比较电压范围
  const check = TekISF.parse(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength), dst);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < check.sampleCount; i++) {
    const v = check.valueAt(i);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  console.log(dst.padEnd(8), String(check.sampleCount).padStart(7) + ' 点',
    String(Math.round(result.length / 1024)).padStart(4) + ' KB',
    ' XINCR=' + check.xIncrement.toExponential(2),
    ' 幅值=[' + mn.toFixed(1) + ', ' + mx.toFixed(1) + '] ' + check.yUnit,
    ' 回读=' + (check.encoding + '/' + check.bitNr + 'bit'));
}
