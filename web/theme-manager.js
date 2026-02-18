/**
 * Theme Manager for Kosmos Panel
 * Handles theme switching and persistence.
 */

const THEMES = [
    { id: 'dark', name: '🌙 Dark', icon: '🌙' },
    { id: 'light', name: '☀️ Light', icon: '☀️' },
    { id: 'cyberpunk', name: '🤖 Cyberpunk', icon: '🤖' },
    { id: 'cyber-hud', name: '🌐 Cyber-HUD', icon: '🌐' }
];

class ThemeManager {
    constructor() {
        this.currentTheme = localStorage.getItem('kosmos-theme') || 'dark';
        this.init();
    }

    init() {
        this.applyTheme(this.currentTheme);
        window.addEventListener('DOMContentLoaded', () => {
            this.setupUI();
        });

        // Listen for changes from other tabs/windows
        window.addEventListener('storage', (e) => {
            if (e.key === 'kosmos-theme') {
                if (e.newValue) {
                    this.applyTheme(e.newValue);
                    this.updateSelectors();
                }
            }
        });
    }

    updateSelectors() {
        const selectors = document.querySelectorAll('.theme-selector');
        selectors.forEach(s => s.value = this.currentTheme);
    }

    applyTheme(themeId) {
        document.documentElement.setAttribute('data-theme', themeId);
        this.currentTheme = themeId;
        localStorage.setItem('kosmos-theme', themeId);

        // Dispatch event for other components if needed
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: themeId } }));
    }

    setupUI() {
        // Check for theme selectors in the DOM
        const selectors = document.querySelectorAll('.theme-selector');

        selectors.forEach(selector => {
            // Clear existing options
            selector.innerHTML = '';

            THEMES.forEach(theme => {
                const option = document.createElement('option');
                option.value = theme.id;
                option.textContent = theme.name; // Simple text for select
                if (theme.id === this.currentTheme) {
                    option.selected = true;
                }
                selector.appendChild(option);
            });

            selector.addEventListener('change', (e) => {
                this.applyTheme(e.target.value);
            });
        });
    }

    getTerminalTheme() {
        const style = getComputedStyle(document.documentElement);
        return {
            background: style.getPropertyValue('--term-bg').trim() || '#000000',
            foreground: style.getPropertyValue('--term-fg').trim() || '#00ff00'
        };
    }
}

// Initialize immediately
window.themeManager = new ThemeManager();
