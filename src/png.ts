/**
 * Just enough PNG to shrink a screenshot that is too large to return to Claude inline, with no
 * native dependency: decode non-interlaced 8- and 16-bit PNGs (and palette images), average
 * pixels down to a smaller size, and encode an 8-bit PNG. Other images are returned unchanged
 * or refused with an explanation; the original is always available through save_to.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Rgba {
  width: number;
  height: number;
  /** Four bytes per pixel. */
  data: Uint8Array;
}
/** Refuse to decode beyond this many pixels (8000 x 5000), to bound memory. */
const MAX_PIXELS = 40_000_000;
/**
 * And beyond this many bytes of raw rows, which the decoder holds twice next to the pixels: an
 * 8000 x 5000 8-bit screenshot fits, the same size at 16 bits per channel does not.
 */
const MAX_ROW_BYTES = 160 * 2 ** 20;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded RGBA pixels, or null for a PNG this decoder does not handle (such as interlaced). */
export function decodePng(bytes: Buffer): Rgba | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === 'IHDR') {
      if (length < 13) return null;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      color = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const supported =
    channels !== undefined &&
    interlace === 0 &&
    (color === 3 ? [1, 2, 4, 8].includes(depth) : [8, 16].includes(depth)) &&
    (color !== 3 || palette !== undefined) &&
    // A transparent color key on a grey or RGB image would come out opaque.
    (transparency === undefined || color === 3);
  if (!supported || !width || !height || width * height > MAX_PIXELS) return null;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  if ((stride + 1) * height > MAX_ROW_BYTES) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;
  // Undo the per-row filters in place.
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= step ? rows[row + x - step]! : 0;
      const up = y > 0 ? rows[row - stride + x]! : 0;
      const corner = y > 0 && x >= step ? rows[row - stride + x - step]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, corner);
      else if (filter !== 0) return null;
      rows[row + x] = (raw[source + x]! + predictor) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  const sample = (y: number, index: number) =>
    depth === 16 ? rows[y * stride + index * 2]! : rows[y * stride + index]!;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      if (color === 3) {
        const bit = x * depth;
        const entry =
          (rows[y * stride + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        pixels[target] = palette![entry * 3] ?? 0;
        pixels[target + 1] = palette![entry * 3 + 1] ?? 0;
        pixels[target + 2] = palette![entry * 3 + 2] ?? 0;
        pixels[target + 3] = transparency?.[entry] ?? 255;
        continue;
      }
      const base = x * channels;
      const gray = color === 0 || color === 4;
      pixels[target] = sample(y, base);
      pixels[target + 1] = gray ? sample(y, base) : sample(y, base + 1);
      pixels[target + 2] = gray ? sample(y, base) : sample(y, base + 2);
      pixels[target + 3] =
        color === 4 ? sample(y, base + 1) : color === 6 ? sample(y, base + 3) : 255;
    }
  return { width, height, data: pixels };
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceCorner = Math.abs(estimate - corner);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceCorner) return left;
  return distanceUp <= distanceCorner ? up : corner;
}

/** Average blocks of pixels so that the longer edge is at most `maxEdge`. */
export function downscale(image: Rgba, maxEdge: number): Rgba {
  const scale = Math.max(image.width, image.height) / maxEdge;
  if (scale <= 1) return image;
  const width = Math.max(1, Math.round(image.width / scale));
  const height = Math.max(1, Math.round(image.height / scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.floor((y * image.height) / height);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const left = Math.floor((x * image.width) / width);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / width));
      const sums = [0, 0, 0, 0];
      for (let sy = top; sy < bottom; sy++)
        for (let sx = left; sx < right; sx++) {
          const index = (sy * image.width + sx) * 4;
          for (let channel = 0; channel < 4; channel++)
            sums[channel]! += image.data[index + channel]!;
        }
      const count = (bottom - top) * (right - left);
      for (let channel = 0; channel < 4; channel++)
        data[(y * width + x) * 4 + channel] = Math.round(sums[channel]! / count);
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit PNG, RGB when every pixel is opaque, each row Paeth-filtered. */
export function encodePng(image: Rgba): Buffer {
  let opaque = true;
  for (let index = 3; index < image.data.length; index += 4)
    if (image.data[index] !== 255) {
      opaque = false;
      break;
    }
  const channels = opaque ? 3 : 4;
  const stride = image.width * channels;
  const rows = new Uint8Array(stride * image.height);
  for (let pixel = 0, target = 0; pixel < image.width * image.height; pixel++) {
    for (let channel = 0; channel < channels; channel++)
      rows[target++] = image.data[pixel * 4 + channel]!;
  }
  const filtered = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    filtered[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? rows[at - channels]! : 0;
      const up = y > 0 ? rows[at - stride]! : 0;
      const corner = y > 0 && x >= channels ? rows[at - stride - channels]! : 0;
      filtered[y * (stride + 1) + 1 + x] = (rows[at]! - paeth(left, up, corner)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
