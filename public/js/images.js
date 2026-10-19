import { IMAGE_MAX_DIMENSION } from './config.js';

const MAY_HAVE_TRANSPARENCY = new Set(['image/png', 'image/gif', 'image/webp', 'image/avif']);

// Redraws an image onto a canvas: this drops EXIF data (location, camera, ...) and shrinks
// very large photos. Transparent images stay PNG; everything else becomes JPEG.
export async function cleanImage(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
        const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const type = MAY_HAVE_TRANSPARENCY.has(file.type) && hasTransparency(context, canvas) ? 'image/png' : 'image/jpeg';
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Could not encode image'))), type, 0.85);
        });
        return { blob, type, name: withExtension(file.name, type === 'image/png' ? 'png' : 'jpg') };
    } finally {
        bitmap.close();
    }
}

function hasTransparency(context, canvas) {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

function withExtension(name, extension) {
    const base = (name || '').replace(/\.[^.]*$/, '') || 'image';
    return `${base}.${extension}`;
}
