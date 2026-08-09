import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const environmentFile = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);

export function loadProjectEnvironment(): void {
  if (existsSync(environmentFile)) {
    loadEnvFile(environmentFile);
  }
}
