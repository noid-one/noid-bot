// Draws noid's PNG icons from the same two rectangles as web/icon.svg: paper, and the ink bar on it. No rasterizer
// needed: each pixel takes the share of it the bar covers, so the edges are smooth at any size.
//   node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const PAPER = [0xfa, 0xfa, 0xf8];
const INK = [0x22, 0x22, 0x22];
// In web/icon.svg's 512 units.
const BAR = { x: 234, y: 97, width: 44, height: 318 };
const SIZES = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-maskable-512.png": 512,
};

/** How much of the pixel from `from` to `from + 1` the span from `start` to `end` covers. */
const cover = (from, start, end) => Math.max(0, Math.min(from + 1, end) - Math.max(from, start));

function draw(size) {
    const scale = size / 512;
    const [left, right] = [BAR.x * scale, (BAR.x + BAR.width) * scale];
    const [top, bottom] = [BAR.y * scale, (BAR.y + BAR.height) * scale];
    // Each row: a filter byte, then RGB.
    const raw = Buffer.alloc(size * (1 + size * 3));

    for (let y = 0; y < size; y++) {
        const row = y * (1 + size * 3);
        const down = cover(y, top, bottom);

        for (let x = 0; x < size; x++) {
            const share = down * cover(x, left, right);

            for (let channel = 0; channel < 3; channel++) {
                raw[row + 1 + x * 3 + channel] = Math.round(
                    PAPER[channel] + (INK[channel] - PAPER[channel]) * share,
                );
            }
        }
    }

    return png(size, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;

    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    return c >>> 0;
});

function crc(buffer) {
    let c = 0xffffffff;

    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }

    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    const sum = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);

    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));

    return Buffer.concat([length, body, sum]);
}

function png(size, raw) {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    // 8 bits a channel, RGB, then compression, filter, and interlace: none of the three.
    header[8] = 8;
    header[9] = 2;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const web = join(import.meta.dirname, "..", "web");

for (const [file, size] of Object.entries(SIZES)) {
    writeFileSync(join(web, file), draw(size));
}
