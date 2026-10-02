/**
 * Generates the Windows app icon from `assets/icon-tile.svg` (SPEC.md §11, NOTES.md §31):
 *
 *   npm run icon
 *
 * Writes `assets/icon.ico` (16, 24, 32, 48, 64, 128, 256) and `assets/icon-256.png` (the
 * notification icon). The SVGs in `assets/` stay the only sources; both outputs are generated.
 *
 * It runs under Electron rather than a converter, because the project has no image library and
 * adding one needs the owner's approval (CLAUDE.md). Chromium rasterises the vector at each size,
 * which is sharper than scaling one bitmap down, and the ICO is assembled here by hand:
 * BMP entries up to 48px (what every Windows shell surface accepts) and PNG entries above, which
 * is how the shell has stored large icons since Vista.
 */

import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets', 'icon-tile.svg');
const ICO = join(ROOT, 'assets', 'icon.ico');
const PNG_256 = join(ROOT, 'assets', 'icon-256.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Above this, the entry is stored as PNG; at or below it, as a BMP with an AND mask. */
const PNG_FROM = 64;

/** Rasterise the SVG at one size, in the page, and hand back the PNG bytes. */
async function rasterise(contents, svg, size) {
  const dataUrl = await contents.executeJavaScript(
    `(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg, 'utf8').toString('base64'))};
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = ${size};
      canvas.height = ${size};
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, ${size}, ${size});
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png');
    })()`,
  );
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  // The same pixels again as raw RGBA, for the BMP entries.
  const rgba = Buffer.from(
    await contents.executeJavaScript(
      `(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = ${size};
        canvas.height = ${size};
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(0, 0, ${size}, ${size}).data];
      })()`,
    ),
  );
  return { png, rgba };
}

/** A 32-bit BMP icon image: BITMAPINFOHEADER, bottom-up BGRA, then the 1bpp AND mask. */
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — colour data plus the mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = from + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // Ignored for 32-bit icons on modern Windows, but it must be there and the right size.
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size, 0);
  header.writeUInt32LE(xor.length + and.length, 20); // biSizeImage
  return Buffer.concat([header, xor, and]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const at = i * 16;
    directory[at] = image.size >= 256 ? 0 : image.size; // 0 means 256
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

async function main() {
  const svg = readFileSync(SOURCE, 'utf8');
  const window = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');

  const images = [];
  for (const size of SIZES) {
    const { png, rgba } = await rasterise(window.webContents, svg, size);
    if (size === 256) {
      mkdirSync(dirname(PNG_256), { recursive: true });
      writeFileSync(PNG_256, png);
    }
    const data = size >= PNG_FROM ? png : bmpEntry(rgba, size);
    images.push({ size, data });
    console.log(`${String(size).padStart(3)}px  ${size >= PNG_FROM ? 'PNG' : 'BMP'}  ${data.length} bytes`);
  }

  const ico = buildIco(images);
  writeFileSync(ICO, ico);
  console.log(`\nWrote ${ICO} (${images.length} sizes, ${ico.length} bytes)`);
  console.log(`Wrote ${PNG_256} (notification icon)`);
  window.destroy();
}

app.whenReady().then(
  () => main().then(() => app.exit(0), (err) => { console.error(err); app.exit(1); }),
  (err) => { console.error(err); app.exit(1); },
);
