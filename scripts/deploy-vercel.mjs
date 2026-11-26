#!/usr/bin/env node
/**
 * One-shot Vercel deploy for School Radio.
 *
 * Reads secrets from .env.local (never committed), pushes them to the Vercel
 * project as environment variables, then deploys to production and prints the
 * deployment URL.
 *
 *   node scripts/deploy-vercel.mjs [--project school-radio]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const PROJECT = process.argv.includes("--project") ? process.argv[process.argv.indexOf("--project") + 1] : "school-radio";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "YOUTUBE_API_KEY", "PLAYER_DEVICE_TOKEN"];
const OPTIONAL = ["PORT"];

function readEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

const env = { ...readEnv(path.join(ROOT, ".env.local")), ...readEnv(path.join(ROOT, ".env")) };

// Accept the older NEXT_PUBLIC_* names used before the rewrite.
if (!env.SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_URL) env.SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
if (!env.SUPABASE_ANON_KEY && env.NEXT_PUBLIC_SUPABASE_ANON_KEY) env.SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const missing = REQUIRED.filter((key) => !env[key]);
if (missing.length) {
  console.error(`Missing in .env.local: ${missing.join(", ")}`);
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, input) =>
  execFileSync(npx, ["--yes", "vercel@latest", ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });

function whoami() {
  try {
    return run(["whoami"]).trim();
  } catch {
    return "";
  }
}

const user = whoami();
if (!user) {
  console.error("Not signed in to Vercel. Run: npx vercel login");
  process.exit(1);
}
console.log(`Vercel account: ${user}`);

const link = path.join(ROOT, ".vercel", "project.json");
if (!fs.existsSync(link)) {
  console.log(`Creating project "${PROJECT}"…`);
  run(["link", "--yes", "--project", PROJECT]);
} else {
  console.log("Project already linked.");
}

for (const key of [...REQUIRED, ...OPTIONAL]) {
  const value = env[key];
  if (!value) continue;
  try {
    run(["env", "add", key, "--environment", "production,preview", "--value", value, "--force", "--yes"]);
    console.log(`set ${key} (production, preview)`);
  } catch (error) {
    console.error(`failed to set ${key}: ${String(error.stderr || error.message).trim()}`);
  }
}

console.log("Deploying to production…");
const output = run(["deploy", "--prod", "--yes"]);
process.stdout.write(output);

const url = (output.match(/https:\/\/[^\s]+\.vercel\.app/g) || []).pop();
if (url) console.log(`\nLive: ${url}`);
