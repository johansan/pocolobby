import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG chunk; the decoder does not check CRCs, so this one carries zeros. */
const chunk = (type: string, body: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
};
const header = (width: number, height: number, depth: number, color: number) => {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = depth;
  body[9] = color;
  return body;
};
const png = (...chunks: Buffer[]) =>
  Buffer.concat([SIGNATURE, ...chunks, chunk('IEND', Buffer.alloc(0))]);

test('a small PNG with huge 16-bit rows is refused before anything is inflated', () => {
  // 8001 x 4999 RGBA at 16 bits: within the pixel count, far beyond the row budget.
  const started = Date.now();
  const image = png(
    chunk('IHDR', header(8001, 4999, 16, 6)),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
  );
  assert.equal(decodePng(image), null);
  assert.ok(Date.now() - started < 1_000);
});

test('a PNG whose header chunk is too short is unsupported, not an error', () => {
  assert.equal(
    decodePng(png(chunk('IHDR', Buffer.alloc(8)), chunk('IDAT', Buffer.alloc(8)))),
    null,
  );
});

test('a small ordinary PNG still decodes', () => {
  const rows = Buffer.concat([Buffer.from([0, 255, 0, 0, 255]), Buffer.from([0, 0, 0, 255, 255])]);
  const image = png(chunk('IHDR', header(1, 2, 8, 6)), chunk('IDAT', deflateSync(rows)));
  const decoded = decodePng(image)!;
  assert.deepEqual([decoded.width, decoded.height], [1, 2]);
  assert.deepEqual([...decoded.data], [255, 0, 0, 255, 0, 0, 255, 255]);
});

test('a grey or RGB PNG with a transparent colour key is refused rather than made opaque', () => {
  // A sweep found that a reduced rendition turned the transparent colour solid.
  const rows = Buffer.from([0, 255, 0, 0]);
  const keyed = png(
    chunk('IHDR', header(1, 1, 8, 2)),
    chunk('tRNS', Buffer.from([0, 255, 0, 0, 0, 0])),
    chunk('IDAT', deflateSync(rows)),
  );
  assert.equal(decodePng(keyed), null);
  // Without the key it still decodes.
  const plain = png(chunk('IHDR', header(1, 1, 8, 2)), chunk('IDAT', deflateSync(rows)));
  assert.deepEqual([...decodePng(plain)!.data], [255, 0, 0, 255]);
});
