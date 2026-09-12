import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync("dist", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");
cpSync("icons", "dist/icons", { recursive: true });

if (existsSync("public")) {
  for (const name of readdirSync("public")) {
    if (name.startsWith(".")) continue;
    cpSync(join("public", name), join("dist", name), { recursive: true });
  }
}
