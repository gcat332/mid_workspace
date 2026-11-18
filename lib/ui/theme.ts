// Light / dark / system preference, stored like AgentHub does: localStorage, class-based `.dark` on <html>.
// Same key as AgentHub ("aiws.theme"): both apps live on one host, so the choice carries over between them.
export const THEME_KEY = "aiws.theme"
export type Theme = "light" | "dark" | "system"

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch { return "system" }
}

export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
}

export function saveTheme(theme: Theme) {
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode: the choice just will not persist */ }
}

/** Inline script that runs before paint so there is no light/dark flash. */
export const themeBootScript =
  `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`
