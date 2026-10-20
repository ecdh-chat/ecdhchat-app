// Script for the site pages: the theme button, and on /download the installers' details with the
// visitor's own system first.
import { initTheme } from './theme.js';

initTheme(document.getElementById('themeToggle'));

const downloads = document.getElementById('downloads');
if (downloads) {
    if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) downloads.dataset.first = 'linux';
    showInstallers();
}

// The installers and latest.json are put in place by scripts/stage-installer.mjs on release. If
// they can't be read the page still links to the installers, just without the details.
async function showInstallers() {
    let release;
    try {
        const res = await fetch('/downloads/latest.json', { cache: 'no-store' });
        if (!res.ok) return;
        release = await res.json();
    } catch {
        return;
    }
    if (!/^\d+\.\d+\.\d+$/.test(release.version)) return;

    for (const details of document.querySelectorAll('[data-installer]')) {
        const installer = release[details.dataset.installer];
        if (!/^[0-9a-f]{64}$/.test(installer?.sha256) || !Number.isInteger(installer.size)) continue;
        details.querySelector('[data-version]').textContent = `Version ${release.version}`;
        details.querySelector('[data-size]').textContent = `${(installer.size / 1024 / 1024).toFixed(1)} MB`;
        details.querySelector('[data-hash]').textContent = installer.sha256;
        details.hidden = false;
    }
}
