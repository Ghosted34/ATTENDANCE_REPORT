import fs from "fs";
export const brand = JSON.parse(fs.readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
