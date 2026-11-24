/*
 * Tektronix ISF / WFM 波形文件解析器（纯浏览器端，零依赖）
 * ---------------------------------------------------------------
 * 支持：
 *   ENCDG  BINARY / ASCII
 *   BN_FMT RI（有符号）/ RP（无符号）/ FP（浮点）
 *   BYT_OR MSB / LSB
 *   BIT_NR 8 / 16 / 32 / 64
 * 电压换算：value = (raw - YOFF) * YMULT + YZERO
 * 时间换算：t = XZERO + (i - PT_OFF) * XINCR
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TekISF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAG_CURVE = [0x3a, 0x43, 0x55, 0x52, 0x56, 0x45]; // ":CURVE"

  /**
   * 返回 ":CURVE" 中 ':' 的字节下标（找不到返回 -1）。
   * 头部很短（一般 < 2KB），只需在前 64KB 内查找。
   */
  function findCurveTag(bytes, limit) {
    const max = Math.min(bytes.length, limit || 65536);
    for (let i = 0; i < max; i++) {
      if (bytes[i] !== 0x3a) continue;
      let hit = true;
      for (let k = 0; k < TAG_CURVE.length; k++) {
        if (bytes[i + k] !== TAG_CURVE[k]) { hit = false; break; }
      }
      if (hit) return i;
    }
    return -1;
  }

  // 按分号切分，保留引号内的分号
  function splitHeader(text) {
    const parts = [];
    let buf = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { quoted = !quoted; buf += ch; continue; }
      if (ch === ';' && !quoted) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  }

  function parseHeader(text) {
    const fields = Object.create(null);
    for (const raw of splitHeader(text)) {
      let part = raw.trim().replace(/^:+/, '');
      part = part.replace(/^WFMPRE:/i, '');
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(part);
      if (!m) continue;
      const key = m[1].toUpperCase();
      let value = m[2].trim();
      if (value.length > 1 && value[0] === '"' && value[value.length - 1] === '"') {
        value = value.slice(1, -1);
      }
      // 同名字段后出现者优先（WFMPRE 段之后常有覆盖值）
      fields[key] = value;
    }
    return fields;
  }

  function num(fields, key, fallback) {
    if (!(key in fields)) return fallback;
    const v = parseFloat(fields[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  function channelFromText(text) {
    const m = /(?:^|[^A-Za-z0-9])CH\s*([1-8])\b/i.exec(text || '');
    return m ? 'CH' + m[1] : '';
  }

  /**
   * 把曲线区字节解码为数值数组（未乘系数）。
   * 16 位、非本机字节序时用字节交换拷贝（比 DataView 循环快数倍）。
   */
  function decodeBinary(bytes, offset, byteLength, bitNr, byteNr, fmt, order) {
    const bytesPerPoint = byteNr || Math.max(1, Math.ceil(bitNr / 8));
    const count = Math.floor(byteLength / bytesPerPoint);
    const littleEndian = String(order || 'MSB').toUpperCase() === 'LSB';
    const isUnsigned = String(fmt || 'RI').toUpperCase() === 'RP';
    const isFloat = String(fmt || '').toUpperCase() === 'FP';
    const platformLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const swap = littleEndian !== platformLittle;

    if (isFloat) {
      if (bitNr === 32 || bytesPerPoint === 4) {
        const out = new Float32Array(count);
        const dst = new Uint8Array(out.buffer);
        const src = bytes.subarray(offset, offset + count * 4);
        if (!swap) dst.set(src);
        else for (let i = 0; i < count; i++) {
          dst[i * 4] = src[i * 4 + 3];
          dst[i * 4 + 1] = src[i * 4 + 2];
          dst[i * 4 + 2] = src[i * 4 + 1];
          dst[i * 4 + 3] = src[i * 4];
        }
        return out;
      }
      const out = new Float64Array(count);
      const dst = new Uint8Array(out.buffer);
      const src = bytes.subarray(offset, offset + count * 8);
      if (!swap) dst.set(src);
      else for (let i = 0; i < count; i++) {
        for (let k = 0; k < 8; k++) dst[i * 8 + k] = src[i * 8 + (7 - k)];
      }
      return out;
    }

    if (bytesPerPoint === 1) {
      const src = bytes.subarray(offset, offset + count);
      return isUnsigned ? Uint8Array.from(src) : Int8Array.from(src);
    }

    if (bytesPerPoint === 2) {
      const out = isUnsigned ? new Uint16Array(count) : new Int16Array(count);
      const dst = new Uint8Array(out.buffer);
      const src = bytes.subarray(offset, offset + count * 2);
      if (!swap) dst.set(src);
      else for (let i = 0; i < count; i++) {
        dst[i * 2] = src[i * 2 + 1];
        dst[i * 2 + 1] = src[i * 2];
      }
      return out;
    }

    if (bytesPerPoint === 4) {
      const out = isUnsigned ? new Uint32Array(count) : new Int32Array(count);
      const dst = new Uint8Array(out.buffer);
      const src = bytes.subarray(offset, offset + count * 4);
      if (!swap) dst.set(src);
      else for (let i = 0; i < count; i++) {
        dst[i * 4] = src[i * 4 + 3];
        dst[i * 4 + 1] = src[i * 4 + 2];
        dst[i * 4 + 2] = src[i * 4 + 1];
        dst[i * 4 + 3] = src[i * 4];
      }
      return out;
    }

    // 其它位宽（如 24 位）：逐点通用解码
    const out = new Int32Array(count);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, byteLength);
    for (let i = 0; i < count; i++) {
      const p = i * bytesPerPoint;
      let v = 0;
      if (littleEndian) for (let k = bytesPerPoint - 1; k >= 0; k--) v = v * 256 + dv.getUint8(p + k);
      else for (let k = 0; k < bytesPerPoint; k++) v = v * 256 + dv.getUint8(p + k);
      if (!isUnsigned && v >= Math.pow(2, bitNr - 1)) v -= Math.pow(2, bitNr);
      out[i] = v;
    }
    return out;
  }

  function latin1(bytes, start, end) {
    // 头部是单字节 ASCII，用 TextDecoder 比逐字符拼接快得多
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('latin1').decode(bytes.subarray(start, end)); } catch (e) { /* 忽略 */ }
    }
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parse(arrayBuffer, fileName) {
    if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error('输入必须是 ArrayBuffer');
    const bytes = new Uint8Array(arrayBuffer);
    const curvePos = findCurveTag(bytes);
    if (curvePos < 0) throw new Error('未找到 :CURVE 标记，可能不是 Tektronix ISF 文件');

    const fields = parseHeader(latin1(bytes, 0, curvePos));

    let pos = curvePos + TAG_CURVE.length;
    while (pos < bytes.length && bytes[pos] <= 0x20) pos++;

    let raw = null;
    let encoding = String(fields.ENCDG || 'BINARY').toUpperCase();

    if (bytes[pos] === 0x23) { // '#'
      pos++;
      const digitCount = bytes[pos] - 0x30;
      if (!(digitCount >= 1 && digitCount <= 9)) throw new Error('CURVE 块长度标记无效');
      pos++;
      let declared = 0;
      for (let i = 0; i < digitCount; i++) declared = declared * 10 + (bytes[pos++] - 0x30);
      // 少数文件在长度头后插入换行/空格
      let skip = 0;
      while (skip < 4 && pos + skip < bytes.length && bytes[pos + skip] <= 0x20 && bytes[pos + skip] !== 0x00) skip++;
      let dataLength = declared;
      if (bytes.length - pos - skip >= declared) pos += skip;
      if (bytes.length - pos < declared) {
        dataLength = bytes.length - pos;
        console.warn('[ISF] CURVE 声明长度超出剩余字节，按实际长度解析');
      }
      encoding = 'BINARY';
      raw = decodeBinary(bytes, pos, dataLength,
        Math.max(1, num(fields, 'BIT_NR', 16)),
        num(fields, 'BYT_NR', 0),
        String(fields.BN_FMT || 'RI').toUpperCase(),
        String(fields.BYT_OR || 'MSB').toUpperCase());
    } else {
      // ASCII 曲线：逗号 / 换行分隔
      const text = latin1(bytes, pos, bytes.length);
      const values = text.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
      if (!values.length) throw new Error('CURVE 数据为空');
      raw = Float32Array.from(values);
      encoding = 'ASCII';
    }

    const bitNr = num(fields, 'BIT_NR', 16);
    const xIncrement = num(fields, 'XINCR', 0);
    const ascii = encoding === 'ASCII';
    const yMult = ascii ? 1 : num(fields, 'YMULT', 1);
    const yOff = ascii ? 0 : num(fields, 'YOFF', 0);
    const yZero = ascii ? 0 : num(fields, 'YZERO', 0);
    const xZero = num(fields, 'XZERO', 0);
    const ptOff = num(fields, 'PT_OFF', 0);
    const sampleCount = raw.length;
    const duration = xIncrement * Math.max(0, sampleCount - 1);
    const wfid = fields.WFID || '';
    const label = channelFromText(wfid) || channelFromText(fileName || '') || 'CH?';
    const startTime = xZero - ptOff * xIncrement;

    return {
      fileName: fileName || 'waveform.isf',
      label,
      wfid,
      encoding,
      fields,
      raw,
      sampleCount,
      bitNr,
      xUnit: fields.XUNIT || 's',
      yUnit: fields.YUNIT || 'V',
      xIncrement,
      xZero,
      ptOff,
      yMult,
      yOff,
      yZero,
      vScale: num(fields, 'VSCALE', 0),
      hScale: num(fields, 'HSCALE', 0),
      vPos: num(fields, 'VPOS', 0),
      vOffset: num(fields, 'VOFFSET', 0),
      hDelay: num(fields, 'HDELAY', 0),
      startTime,
      endTime: startTime + duration,
      duration,
      sampleRate: xIncrement > 0 ? 1 / xIncrement : 0,
      valueAt(i) { return (this.raw[i] - this.yOff) * this.yMult + this.yZero; },
      timeAt(i) { return this.startTime + i * this.xIncrement; },
      indexAtTime(t) { return this.xIncrement ? (t - this.startTime) / this.xIncrement : 0; }
    };
  }

  return { parse, parseHeader, findCurveTag, decodeBinary };
});
