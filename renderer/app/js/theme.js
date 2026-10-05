// Theme: cookie (shared across launches; localStorage would reset with the random port) else OS setting.
const saved = document.cookie.match(/(?:^|; )theme=(light|dark)/)?.[1];
document.documentElement.dataset.theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
window.toggleTheme = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  document.cookie = `theme=${t}; max-age=31536000; path=/`;
};
