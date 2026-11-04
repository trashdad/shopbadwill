// Generates public/icon/{16,32,48,128}.png: a white price tag on a blue
// rounded square. Node built-ins only (zlib + manual PNG encoding).
// Run: pnpm exec tsx scripts/gen-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BG: [number, number, number] = [0x1a, 0x56, 0xdb];
const FG: [number, number, number] = [0xff, 0xff, 0xff];
// Tag pointing right, in unit coordinates.
const TAG: Array<[number, number]> = [
  [0.2, 0.14],
  [0.62, 0.14],
  [0.9, 0.5],
  [0.62, 0.86],
  [0.2, 0.86],
];
const HOLE = { x: 0.36, y: 0.5, r: 0.085 };
const SS = 4;

function inPoly(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = TAG.length - 1; i < TAG.length; j = i++) {
    const [xi, yi] = TAG[i] as [number, number];
    const [xj, yj] = TAG[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x: number, y: number): boolean {
  const r = 0.2;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function pixel(px: number, py: number, size: number): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / size;
      const y = (py + (sy + 0.5) / SS) / size;
      if (!inRoundedSquare(x, y)) continue;
      const hole = (x - HOLE.x) ** 2 + (y - HOLE.y) ** 2 <= HOLE.r ** 2;
      const c = inPoly(x, y) && !hole ? FG : BG;
      r += c[0];
      g += c[1];
      b += c[2];
      a += 255;
    }
  }
  const n = SS * SS;
  const covered = a / 255;
  if (covered === 0) return [0, 0, 0, 0];
  return [Math.round(r / covered), Math.round(g / covered), Math.round(b / covered), Math.round(a / n)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0
    for (let x = 0; x < size; x++) row.set(pixel(x, y, size), 1 + x * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = join(import.meta.dirname, '..', 'public', 'icon');
mkdirSync(dir, { recursive: true });
for (const size of SIZES) writeFileSync(join(dir, `${String(size)}.png`), png(size));
