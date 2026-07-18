import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const backupPath = path.join(rootDir, ".package.json.prepack.backup");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizePackageJson(packageJson) {
  const sanitized = { ...packageJson };
  const dependencies = { ...(sanitized.dependencies ?? {}) };

  delete dependencies["wanxiangshu"];

  sanitized.dependencies = dependencies;

  return sanitized;
}

async function prepare() {
  if (await fileExists(backupPath)) {
    throw new Error(`Backup already exists: ${backupPath}`);
  }

  const originalText = await fs.readFile(packageJsonPath, "utf8");
  await fs.writeFile(backupPath, originalText);

  const packageJson = JSON.parse(originalText);
  const sanitized = sanitizePackageJson(packageJson);
  await fs.writeFile(packageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

async function restore() {
  if (!(await fileExists(backupPath))) {
    return;
  }

  const originalText = await fs.readFile(backupPath, "utf8");
  await fs.writeFile(packageJsonPath, originalText);
  await fs.rm(backupPath, { force: true });
}

const mode = process.argv[2];

if (mode === "prepare") {
  await prepare();
} else if (mode === "restore") {
  await restore();
} else {
  throw new Error(`Unknown mode: ${mode ?? "<missing>"}`);
}
