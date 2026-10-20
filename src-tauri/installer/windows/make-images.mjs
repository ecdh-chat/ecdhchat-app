// Renders the installer's header and sidebar images from the app logo.
// Run from the repo root with: node src-tauri/installer/make-images.mjs
// NSIS needs uncompressed 24-bit BMPs at exactly these sizes.

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const here = new URL('.', import.meta.url);
const logo = readFileSync(new URL('../../../public/favicon.svg', import.meta.url), 'utf8');
const font = '"Segoe UI", -apple-system, Roboto, Arial, sans-serif';

const images = {
    // Top-right corner of every installer page, on white.
    'header.bmp': {
        width: 150,
        height: 57,
        html: `<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-right:12px;box-sizing:border-box;font:600 14px ${font};color:#18181b">
            ecdh.chat<div style="width:30px;height:30px">${logo}</div></div>`,
    },
    // Left side of the welcome and finish pages.
    'sidebar.bmp': {
        width: 164,
        height: 314,
        html: `<div style="width:164px;height:314px;background:#18181b;color:#fafafa;display:flex;flex-direction:column;align-items:center;padding-top:56px;box-sizing:border-box;font:13px ${font};text-align:center">
            <div style="width:64px;height:64px;border-radius:16px;box-shadow:0 0 0 1px #3f3f46">${logo}</div>
            <div style="margin-top:18px;font-weight:600;font-size:20px;letter-spacing:-0.01em">ecdh.chat</div>
            <div style="margin-top:8px;color:#a1a1aa;line-height:1.5">Private chat,<br>peer to peer,<br>encrypted end to end.</div>
            <div style="margin-top:auto;margin-bottom:18px;font:11px ui-monospace,Consolas,monospace;color:#52525b">3f·a9·c1·7e</div></div>`,
    },
};

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, { width, height, html }] of Object.entries(images)) {
    await page.setViewportSize({ width, height });
    await page.setContent(`<body style="margin:0">${html}</body>`);
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
    // The browser decodes its own PNG, so no image library is needed here.
    const rgba = await page.evaluate(async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
    }, png.toString('base64'));
    writeFileSync(new URL(name, here), bmp(width, height, rgba));
    console.log(`wrote src-tauri/installer/${name}`);
}
await browser.close();

// A bottom-up 24-bit BMP, with each row padded to a multiple of 4 bytes.
function bmp(width, height, rgba) {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const size = 54 + rowSize * height;
    const out = Buffer.alloc(size);
    out.write('BM', 0);
    out.writeUInt32LE(size, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(width, 18);
    out.writeInt32LE(height, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(rowSize * height, 34);
    for (let y = 0; y < height; y++) {
        const row = 54 + (height - 1 - y) * rowSize;
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            out[row + x * 3] = rgba[i + 2];
            out[row + x * 3 + 1] = rgba[i + 1];
            out[row + x * 3 + 2] = rgba[i];
        }
    }
    return out;
}
