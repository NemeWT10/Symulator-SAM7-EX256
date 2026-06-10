/* Minimalny koder PNG (deflate "stored", bez kompresji) — do testów. */
'use strict';

function crc32(buf, start, end) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let c = ~0;
  for (let i = start; i < end; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// rgba: Uint8ClampedArray w*h*4
function encodePNG(rgba, w, h) {
  // dane rastrowe z filtrem 0 na każdej linii
  const raw = Buffer.alloc(h * (1 + w * 4));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w * 4; x++) raw[p++] = rgba[y * w * 4 + x];
  }
  // zlib: nagłówek + bloki stored (max 65535)
  const blocks = [];
  blocks.push(Buffer.from([0x78, 0x01]));
  let off = 0;
  while (off < raw.length) {
    const n = Math.min(65535, raw.length - off);
    const last = off + n >= raw.length ? 1 : 0;
    const hdr = Buffer.from([last, n & 0xFF, n >> 8, (~n) & 0xFF, ((~n) >> 8) & 0xFF]);
    blocks.push(hdr, raw.subarray(off, off + n));
    off += n;
  }
  const ad = Buffer.alloc(4);
  ad.writeUInt32BE(adler32(raw), 0);
  blocks.push(ad);
  const idat = Buffer.concat(blocks);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { encodePNG };
