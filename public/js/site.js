// Script for the site pages: the theme button, and the installer's details on /download.
import { initTheme } from './theme.js';

initTheme(document.getElementById('themeToggle'));

// The installer and latest.json are put in place by scripts/stage-installer.mjs on release. If
// they can't be read the page still links to the installer, just without the details.
const details = document.getElementById('installerDetails');
if (details) showInstaller(details);

async function showInstaller(details) {
    let release;
    try {
        const res = await fetch('/downloads/latest.json', { cache: 'no-store' });
        if (!res.ok) return;
        release = await res.json();
    } catch {
        return;
    }
    if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[0-9a-f]{64}$/.test(release.sha256) || !Number.isInteger(release.size)) return;

    document.getElementById('installerVersion').textContent = `Version ${release.version}`;
    document.getElementById('installerSize').textContent = `${(release.size / 1024 / 1024).toFixed(1)} MB`;
    document.getElementById('installerHash').textContent = release.sha256;
    details.hidden = false;
}
