// Runs before the page renders so a saved theme doesn't flash the wrong colours, and so the
// desktop app gets its own layout from the first frame.
if ('__TAURI_INTERNALS__' in window) document.documentElement.classList.add('app');
try {
    const theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.classList.add(`theme-${theme}`);
} catch {
    // Storage can be blocked; the system theme is used then.
}
