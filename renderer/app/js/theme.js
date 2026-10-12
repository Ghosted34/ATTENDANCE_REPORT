// Theme: cookie (shared across launches; localStorage would reset with the random port) else OS setting.
// Density: cookie-based toggle between comfortable (40px) and compact (32px) row heights.
// Grouping: cookie-based toggle between grouped and flat table display.

const savedTheme = document.cookie.match(/(?:^|; )theme=(light|dark)/)?.[1];
const savedDensity = document.cookie.match(/(?:^|; )density=(comfortable|compact)/)?.[1];
const savedGroupBy = document.cookie.match(/(?:^|; )groupBy=(true|false)/)?.[1];

document.documentElement.dataset.theme = savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.density = savedDensity || "comfortable";
document.documentElement.dataset.groupBy = savedGroupBy || "true";

window.toggleTheme = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  document.cookie = `theme=${t}; max-age=31536000; path=/`;
};

window.toggleDensity = () => {
  const d = document.documentElement.dataset.density === "compact" ? "comfortable" : "compact";
  document.documentElement.dataset.density = d;
  document.cookie = `density=${d}; max-age=31536000; path=/`;
};

window.toggleGroupBy = () => {
  const g = document.documentElement.dataset.groupBy === "true" ? "false" : "true";
  document.documentElement.dataset.groupBy = g;
  document.cookie = `groupBy=${g}; max-age=31536000; path=/`;
  return g === "true";
};

window.getGroupBy = () => document.documentElement.dataset.groupBy === "true";
