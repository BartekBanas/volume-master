import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  name: string;
  version: string;
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const manifestPath = join(dist, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const archive = join(
  root,
  `${manifest.name.toLowerCase().replaceAll(" ", "-")}-${manifest.version}.zip`,
);
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

if (!existsSync(dist) || !existsSync(manifestPath)) {
  throw new Error("dist/ is missing. Run npm run build first.");
}

rmSync(archive, { force: true });

if (process.platform === "win32") {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path ${powershellQuote(join(dist, "*"))} -DestinationPath ${powershellQuote(archive)}`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-r", archive, "."], {
    cwd: dist,
    stdio: "inherit",
  });
}

console.log(`Created ${archive}`);
