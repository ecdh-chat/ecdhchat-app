const THEMES = ['system', 'light', 'dark'];
const LABELS = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

export function initTheme(button) {
    let theme = savedTheme();
    apply(theme);

    button.addEventListener('click', () => {
        theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        apply(theme);
        try {
            localStorage.setItem('theme', theme);
        } catch {
            // Not saved; the choice still applies until the page closes.
        }
    });

    function apply(next) {
        const root = document.documentElement;
        root.classList.toggle('theme-light', next === 'light');
        root.classList.toggle('theme-dark', next === 'dark');
        button.dataset.theme = next;
        button.setAttribute('aria-label', LABELS[next]);
        button.title = LABELS[next];
    }
}

function savedTheme() {
    try {
        const theme = localStorage.getItem('theme');
        return THEMES.includes(theme) ? theme : 'system';
    } catch {
        return 'system';
    }
}
