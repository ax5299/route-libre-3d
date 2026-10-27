import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Échantillonneur de pixels sans dépendance : décode un PNG 8 bits (RGB/RGBA,
 * non entrelacé) et affiche une colonne verticale + des points nommés.
 * Usage: node scripts/pngsample.mjs .smoke/03-chase.png [colonne=640]
 */
const decodePng = (buffer) => {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`PNG non supporté (depth=${data[8]}, interlace=${data[12]})`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : (() => {
    throw new Error(`Type de couleur non supporté: ${colorType}`);
  })();
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let delta = 0;
      if (filter === 1) delta = left;
      else if (filter === 2) delta = up;
      else if (filter === 3) delta = (left + up) >> 1;
      else if (filter === 4) delta = paeth(left, up, upLeft);
      line[x] = (value + delta) & 0xff;
    }
    source += stride;
  }
  return { width, height, channels, pixels };
};

const file = process.argv[2] ?? ".smoke/03-chase.png";
const column = Number(process.argv[3] ?? 640);
const image = decodePng(readFileSync(file));
const at = (x, y) => {
  const i = (y * image.width + x) * image.channels;
  return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
};
console.log(`${file} ${image.width}x${image.height} channels=${image.channels}`);
console.log(`-- colonne x=${column} --`);
for (let y = 0; y < Math.min(image.height, 260); y += 8) {
  const [r, g, b] = at(column, y);
  const tint = r > b + 18 ? "chaud" : b > r + 18 ? "froid" : "neutre";
  console.log(`y=${String(y).padStart(4)} rgb=(${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)}) ${tint}`);
}
console.log("-- points --");
const luma = (x, y) => {
  const [r, g, b] = at(x, y);
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
};
for (const [label, x, y] of [
  ["ciel haut", column, 24],
  ["ciel milieu", 300, 70],
  ["horizon droit", 1150, 90],
  ["route centre", column, 300],
  ["route lointaine", column, 200],
  ["herbe gauche", 90, 210],
  ["bitume bas", 300, 560],
  ["caisse voiture", column, 650],
]) {
  if (x >= image.width || y >= image.height) continue;
  const [r, g, b] = at(x, y);
  console.log(`${label.padEnd(15)} (${x},${y}) rgb=(${r},${g},${b}) luma=${luma(x, y)}`);
}
let min = 255;
let max = 0;
let sum = 0;
let count = 0;
for (let i = 0; i < image.pixels.length; i += image.channels) {
  const l = 0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2];
  min = Math.min(min, l);
  max = Math.max(max, l);
  sum += l;
  count += 1;
}
console.log(`luma image: min=${min.toFixed(0)} avg=${(sum / count).toFixed(1)} max=${max.toFixed(0)}`);
