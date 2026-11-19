// Run only on the trusted machine that owns the Gemini sandbox account.
import { existsSync } from "node:fs";
import { phoneConfig } from "../server/phone-config.mjs";
import { PhoneStore } from "../server/phone-store.mjs";
import { SQLiteRepository } from "../server/repository.mjs";
for (const file of [".env", process.env.SERVER_ENV_FILE ?? "../UBC-Hackathon/.env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const repo = new SQLiteRepository(process.env.SQLITE_PATH || "data/capture.sqlite");
try {
  console.log("One-call keypad code (5 minutes):", new PhoneStore(repo, phoneConfig()).issueCode());
} finally {
  repo.close();
}
