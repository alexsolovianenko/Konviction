// Run on the machine hosting the local sandbox. The one-time secret stays in the URL fragment.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { SQLiteRepository } from "../server/repository.mjs";
import { TrustedDevices } from "../server/trusted-device.mjs";
for (const file of [".env", process.env.SERVER_ENV_FILE ?? "../UBC-Hackathon/.env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const repo = new SQLiteRepository(process.env.SQLITE_PATH || "data/capture.sqlite");
try {
  const code = new TrustedDevices(repo).issueCode();
  const url = "http://localhost:5173/#pair=" + code;
  if (process.argv.includes("--open")) {
    execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  } else console.log(url);
} finally {
  repo.close();
}
