// The desk's small preferences, all in cookies: this page is served from a random port, so
// localStorage would be a different store on every launch.
//   theme    light or dark, else the OS setting
//   density  comfortable (40px rows) or compact (32px)
//   groupBy  grouped (a heading and a count per department) or flat
//   cols_<id> the columns the reader has hidden on one report
//   win_<id>  the window that report was last run with
//
// The last two are per report: two reports can share a column key or a date and still be read
// differently, and a preference set on Absentees should not rearrange Daily attendance.

const cookieValue = (name) => {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? match[1] : "";
};
const writeCookie = (name, value) => {
  document.cookie = `${name}=${value}; max-age=31536000; path=/; SameSite=Lax`;
};

const savedTheme = document.cookie.match(/(?:^|; )theme=(light|dark)/)?.[1];
const savedDensity = document.cookie.match(/(?:^|; )density=(comfortable|compact)/)?.[1];
const savedGroupBy = document.cookie.match(/(?:^|; )groupBy=(true|false)/)?.[1];

document.documentElement.dataset.theme = savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.density = savedDensity || "comfortable";
document.documentElement.dataset.groupBy = savedGroupBy || "true";

window.toggleTheme = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  writeCookie("theme", t);
};

window.toggleDensity = () => {
  const d = document.documentElement.dataset.density === "compact" ? "comfortable" : "compact";
  document.documentElement.dataset.density = d;
  writeCookie("density", d);
};

window.toggleGroupBy = () => {
  const g = document.documentElement.dataset.groupBy === "true" ? "false" : "true";
  document.documentElement.dataset.groupBy = g;
  writeCookie("groupBy", g);
  return g === "true";
};

window.getGroupBy = () => document.documentElement.dataset.groupBy === "true";

/** Sets the grouping preference outright (the URL named it, so the URL wins over the cookie). */
window.setGroupBy = (on) => {
  document.documentElement.dataset.groupBy = String(Boolean(on));
  writeCookie("groupBy", String(Boolean(on)));
  return Boolean(on);
};

/** Reads a JSON cookie, tolerating anything that is not the shape we wrote. */
const readJson = (name) => {
  const raw = cookieValue(name);
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

/** Column keys the reader has hidden on this report. */
window.getHiddenColumns = (reportId) => {
  const list = readJson(`cols_${reportId}`);
  return Array.isArray(list) ? list.filter((key) => typeof key === "string") : [];
};

window.setHiddenColumns = (reportId, keys) =>
  writeCookie(`cols_${reportId}`, encodeURIComponent(JSON.stringify([...keys])));

/** The window this report was last run with, so reopening it does not start over at today. */
window.getLastWindow = (reportId) => readJson(`win_${reportId}`);

window.setLastWindow = (reportId, values) =>
  writeCookie(`win_${reportId}`, encodeURIComponent(JSON.stringify(values)));
