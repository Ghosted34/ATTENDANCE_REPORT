import fs from "fs";

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));

export const brand = read("../brand.json");

/**
 * The version shown on the sign-in card, from package.json. A build that cannot read it — a
 * repackaged app, a pruned tree — still has to start, so this fails to an empty string rather
 * than throwing on import.
 */
export const version = (() => {
  try {
    return String(read("../package.json").version || "");
  } catch {
    return "";
  }
})();
