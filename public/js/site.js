// Script for the site pages: the theme button, the story on /about, and on /download the
// installers' details with the visitor's own system first.

initThemeToggle(document.getElementById('themeToggle'));

const downloads = document.getElementById('downloads');
if (downloads) {
    if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
        const windows = downloads.querySelector('[data-os="windows"]');
        for (const linux of downloads.querySelectorAll('[data-os="linux"]')) windows.before(linux);
    }
    showInstallers();
}

const story = document.getElementById('story');
if (story) import('./story.js').then(({ initStory }) => initStory(story));

// The button switches between light and dark. Until it's used the system theme applies. The
// choice is saved the same way the chat saves it (js/theme-boot.js reads it).
function initThemeToggle(button) {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark = () => root.classList.contains('theme-dark') || (!root.classList.contains('theme-light') && systemDark.matches);
    const label = () => button.setAttribute('aria-label', isDark() ? 'Dark theme on. Switch to light' : 'Light theme on. Switch to dark');

    label();
    systemDark.addEventListener('change', label);
    button.addEventListener('click', () => {
        const theme = isDark() ? 'light' : 'dark';
        root.classList.toggle('theme-light', theme === 'light');
        root.classList.toggle('theme-dark', theme === 'dark');
        label();
        try {
            localStorage.setItem('theme', theme);
        } catch {
            // Not saved; the choice still applies until the page closes.
        }
    });
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

    const released = /^\d{4}-\d{2}-\d{2}$/.test(release.released) ? new Date(`${release.released}T00:00:00Z`) : null;
    const date = released && !Number.isNaN(released.getTime())
        ? ` · ${released.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
        : '';
    document.getElementById('release').textContent = `Version ${release.version}${date}`;

    for (const details of document.querySelectorAll('[data-installer]')) {
        const installer = release[details.dataset.installer];
        if (!/^[0-9a-f]{64}$/.test(installer?.sha256) || !Number.isInteger(installer.size)) continue;
        details.querySelector('[data-version]').textContent = release.version;
        details.querySelector('[data-size]').textContent = `${(installer.size / 1024 / 1024).toFixed(1)} MB`;
        details.querySelector('[data-hash]').textContent = installer.sha256;
        details.querySelector('.hash').hidden = false;
        details.classList.add('listed');
    }
}
