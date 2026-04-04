import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { remember } from "./remember.js";
import { ingestGit } from "./ingest/git.js";
import { query, disconnect } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// cli/dist/commands/setup.js → cli/ → project root
const PROJECT_ROOT = resolve(__dirname, "../../..");

// ─── Helpers ────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` (${defaultVal})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

function askMultiSelect(question: string, options: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    console.log(`  ${question}`);
    options.forEach((o, i) => console.log(`    [${i + 1}] ${o}`));
    rl.question("  Enter numbers (comma-separated, or 'all'): ", (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "all" || a === "*") {
        resolve(options);
      } else {
        const indices = a.split(",").map((s) => parseInt(s.trim()) - 1);
        resolve(indices.filter((i) => i >= 0 && i < options.length).map((i) => options[i]));
      }
    });
  });
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function print(msg: string) {
  console.log(msg);
}

function success(msg: string) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
}

function header(step: number, total: number, title: string) {
  console.log("");
  console.log(`  ── Step ${step}/${total}: ${title} ──`);
}

// ─── Setup Steps ────────────────────────────────────────────

async function checkPrerequisites(): Promise<boolean> {
  header(1, 7, "Prerequisites");
  let allGood = true;

  // Docker
  if (commandExists("docker")) {
    const version = execSync("docker --version", { encoding: "utf-8" }).trim();
    success(`Docker: ${version.split(",")[0]}`);
  } else {
    fail("Docker not found. Install Docker Desktop: https://docker.com/get-started");
    allGood = false;
  }

  // Node
  if (commandExists("node")) {
    const version = execSync("node --version", { encoding: "utf-8" }).trim();
    success(`Node.js: ${version}`);
  } else {
    fail("Node.js not found. Install Node 18+: https://nodejs.org");
    allGood = false;
  }

  // Ollama
  if (commandExists("ollama")) {
    success("Ollama: installed");

    // Check if nomic-embed-text is pulled
    try {
      const models = execSync("ollama list 2>/dev/null", { encoding: "utf-8" });
      if (models.includes("nomic-embed-text")) {
        success("Embedding model: nomic-embed-text ready");
      } else {
        print("  ⟳ Pulling embedding model (nomic-embed-text)...");
        execSync("ollama pull nomic-embed-text", { stdio: "inherit" });
        success("Embedding model: nomic-embed-text ready");
      }
    } catch {
      print("  ⟳ Starting Ollama and pulling model...");
      try {
        execSync("ollama serve &", { stdio: "ignore" });
        execSync("sleep 3 && ollama pull nomic-embed-text", { stdio: "inherit" });
        success("Embedding model ready");
      } catch {
        fail("Could not start Ollama. Run 'ollama serve' in another terminal, then re-run setup.");
        allGood = false;
      }
    }
  } else {
    const install = await askYesNo("Ollama not found. Install it?");
    if (install) {
      print("  ⟳ Installing Ollama...");
      print("  Run this in your terminal: curl -fsSL https://ollama.com/install.sh | sudo sh");
      print("  Then: ollama serve & ollama pull nomic-embed-text");
      print("  Then re-run: shb setup");
      allGood = false;
    } else {
      print("  You can use OpenAI embeddings instead. Set SHB_EMBEDDING_PROVIDER=openai in .env");
    }
  }

  return allGood;
}

async function setupDatabase(): Promise<boolean> {
  header(2, 7, "Database");

  // Create .env if it doesn't exist
  const envPath = resolve(PROJECT_ROOT, ".env");
  const envExamplePath = resolve(PROJECT_ROOT, ".env.example");
  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, envPath);
    print("  Created .env from .env.example");
  }

  // Find an available port
  let port = 5432;
  try {
    const ss = execSync("ss -tlnp 2>/dev/null | grep :5432 || true", { encoding: "utf-8" });
    if (ss.trim()) {
      port = 5499;
      print(`  Port 5432 in use, using ${port} instead`);
    }
  } catch { /* ignore */ }

  // Update .env with port
  if (existsSync(envPath)) {
    let env = readFileSync(envPath, "utf-8");
    env = env.replace(/SHB_DB_PORT=\d+/, `SHB_DB_PORT=${port}`);
    if (!env.includes("SHB_EMBEDDING_PROVIDER=ollama")) {
      env = env.replace(/SHB_EMBEDDING_PROVIDER=\w+/, "SHB_EMBEDDING_PROVIDER=ollama");
    }
    writeFileSync(envPath, env);
  }

  // Start Docker
  print("  ⟳ Starting PostgreSQL + pgvector...");
  try {
    execSync(`cd "${PROJECT_ROOT}" && docker compose up -d 2>&1`, { encoding: "utf-8" });
  } catch (e) {
    fail("Docker compose failed. Is Docker running?");
    return false;
  }

  // Wait for healthy
  print("  ⟳ Waiting for database...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`docker exec shb-postgres pg_isready -U shb -d shb 2>/dev/null`, { encoding: "utf-8" });
      ready = true;
      break;
    } catch {
      execSync("sleep 1");
    }
  }

  if (!ready) {
    fail("Database did not start in time");
    return false;
  }

  // Set SCRAM password (Docker pgvector quirk)
  try {
    execSync(`docker exec shb-postgres psql -U shb -d shb -c "SET password_encryption = 'scram-sha-256'; ALTER USER shb WITH PASSWORD 'shb_dev_password';"`, { encoding: "utf-8" });
  } catch { /* ignore if fails */ }

  // Verify connection from CLI
  try {
    await query("SELECT 1");
    success(`Database ready on port ${port}`);
    return true;
  } catch (e) {
    fail(`Cannot connect: ${(e as Error).message}`);
    return false;
  }
}

async function collectPersonalInfo(): Promise<void> {
  header(3, 7, "About You");
  print("  Tell me about yourself so the brain can personalize to you.");
  print("  (Press Enter to skip any question)\n");

  const name = await ask("What's your full name?");
  const location = await ask("Where are you located? (city, state/country)");
  const role = await ask("What's your current role/title?");
  const company = await ask("Where do you work?");
  const expertise = await ask("What are your areas of expertise? (comma-separated)");
  const languages = await ask("What programming languages do you use? (comma-separated)");
  const tools = await ask("What AI tools do you use? (e.g. Hermes, ChatGPT, Claude)");
  const spokenLangs = await ask("What languages do you speak? (e.g. English, Spanish)");
  const education = await ask("Education? (e.g. BS Computer Science, MIT 2020)");
  const hobbies = await ask("Hobbies or interests outside work?");
  const standards = await ask("Any coding standards or preferences? (e.g. prefer functional, no semicolons)");
  const anything = await ask("Anything else the brain should know about you?");

  print("\n  ⟳ Storing your profile in the brain...");

  // Store each non-empty answer as a user memory
  if (name || location || spokenLangs) {
    const parts = [];
    if (name) parts.push(`Name: ${name}`);
    if (location) parts.push(`Location: ${location}`);
    if (spokenLangs) parts.push(`Languages spoken: ${spokenLangs}`);
    await remember({
      type: "user",
      title: `${name || "User"} — Identity`,
      content: parts.join(". "),
      tags: ["identity", "personal"],
      importance: 1.0,
      source: "setup",
    });
  }

  if (role || company) {
    const parts = [];
    if (role) parts.push(`Role: ${role}`);
    if (company) parts.push(`Company: ${company}`);
    await remember({
      type: "user",
      title: `${name || "User"} — Current Role`,
      content: parts.join(". "),
      tags: ["career", "current-role"],
      importance: 0.9,
      source: "setup",
    });
  }

  if (expertise) {
    await remember({
      type: "user",
      title: `${name || "User"} — Expertise`,
      content: `Areas of expertise: ${expertise}`,
      tags: ["skills", "expertise"],
      importance: 0.9,
      source: "setup",
    });
  }

  if (languages || tools) {
    const parts = [];
    if (languages) parts.push(`Programming languages: ${languages}`);
    if (tools) parts.push(`AI tools: ${tools}`);
    await remember({
      type: "user",
      title: `${name || "User"} — Technical Stack`,
      content: parts.join(". "),
      tags: ["skills", "technical", "tools"],
      importance: 0.8,
      source: "setup",
    });
  }

  if (education) {
    await remember({
      type: "user",
      title: `${name || "User"} — Education`,
      content: `Education: ${education}`,
      tags: ["education"],
      importance: 0.7,
      source: "setup",
    });
  }

  if (hobbies) {
    await remember({
      type: "user",
      title: `${name || "User"} — Interests`,
      content: `Hobbies and interests: ${hobbies}`,
      tags: ["personal", "hobbies"],
      importance: 0.6,
      source: "setup",
    });
  }

  if (standards) {
    await remember({
      type: "feedback",
      title: "Coding Standards",
      content: `User coding preferences: ${standards}`,
      tags: ["standards", "preferences"],
      importance: 0.8,
      source: "setup",
    });
  }

  if (anything) {
    await remember({
      type: "user",
      title: `${name || "User"} — Additional Context`,
      content: anything,
      tags: ["personal"],
      importance: 0.5,
      source: "setup",
    });
  }

  const count = [name, location, role, company, expertise, languages, tools, education, hobbies, standards, anything]
    .filter(Boolean).length;
  success(`Stored ${count} profile memories`);
}

async function scanProjects(): Promise<void> {
  header(4, 7, "Your Projects");

  // Auto-detect: go up from project root to find the repos parent directory
  const defaultReposDir = resolve(PROJECT_ROOT, "..");
  const reposDir = await ask("Where are your repos? (directory path)", defaultReposDir);

  // Convert Windows paths to WSL if needed
  const normalizedDir = reposDir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);

  if (!existsSync(normalizedDir)) {
    print(`  Directory not found: ${normalizedDir}`);
    if (normalizedDir !== reposDir) print(`  (converted from: ${reposDir})`);
    return;
  }

  // Find directories that contain .git
  const entries = readdirSync(normalizedDir, { withFileTypes: true });
  const repos = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      const gitPath = resolve(normalizedDir, name, ".git");
      return existsSync(gitPath);
    });

  if (repos.length === 0) {
    print("  No git repos found in that directory");
    return;
  }

  print(`  Found ${repos.length} git repos:\n`);
  const selected = await askMultiSelect("Which repos should the brain learn from?", repos);

  if (selected.length === 0) {
    print("  No repos selected, skipping");
    return;
  }

  print(`\n  ⟳ Ingesting git history for ${selected.length} repos...`);

  let totalStored = 0;
  for (const repo of selected) {
    const repoPath = resolve(normalizedDir, repo);
    try {
      const result = await ingestGit(repoPath, { limit: 30 });
      totalStored += result.stored;
      success(`${repo}: ${result.stored} memories stored`);
    } catch (e) {
      fail(`${repo}: ${(e as Error).message}`);
    }
  }

  success(`Total: ${totalStored} project memories stored`);
}

async function setupGateway(): Promise<void> {
  header(5, 7, "Gateway API");
  print("  The gateway is an HTTP API that lets your AI agent talk to the brain.");
  print("  Default: http://0.0.0.0:18789\n");

  const setKey = await askYesNo("Set an API key for the gateway?");
  if (setKey) {
    const key = await ask("Enter an API key (or press Enter for a random one)");
    const envPath = resolve(PROJECT_ROOT, ".env");
    if (existsSync(envPath)) {
      let env = readFileSync(envPath, "utf-8");
      const apiKey = key || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      if (env.includes("SHB_API_KEY=")) {
        env = env.replace(/SHB_API_KEY=.*/, `SHB_API_KEY=${apiKey}`);
      } else {
        env += `\n# Gateway authentication\nSHB_API_KEY=${apiKey}\n`;
      }
      writeFileSync(envPath, env);
      success(`API key set: ${apiKey}`);
    }
  } else {
    print("  Gateway will run without auth. Set SHB_API_KEY in .env later to secure it.");
  }
}

async function buildCli(): Promise<void> {
  header(6, 7, "Build CLI");

  const cliDir = resolve(PROJECT_ROOT, "cli");

  print("  ⟳ Building shb CLI...");
  try {
    execSync(`cd "${cliDir}" && npm run build 2>&1`, { encoding: "utf-8" });
    success("CLI built successfully");
  } catch {
    print("  CLI already built, skipping");
  }

  // Check if globally linked
  try {
    execSync("which shb 2>/dev/null", { encoding: "utf-8" });
    success("shb command available globally");
  } catch {
    print("  ⟳ Linking shb globally...");
    try {
      execSync(`cd "${cliDir}" && npm link 2>&1`, { encoding: "utf-8" });
      success("shb command linked globally");
    } catch {
      print("  Could not link globally. Run: cd cli && sudo npm link");
    }
  }
}

async function verify(): Promise<void> {
  header(7, 7, "Verify");

  try {
    const stats = await query<{
      total: string;
      links: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM memories)::TEXT AS total,
        (SELECT COUNT(*) FROM memory_links)::TEXT AS links`
    );

    const { total, links } = stats.rows[0];
    success(`${total} memories stored`);
    success(`${links} relationships discovered`);
    success("Brain is ready!");

    print("\n  ╔══════════════════════════════════════════╗");
    print("  ║  SHB Brain is set up!                     ║");
    print("  ╚══════════════════════════════════════════╝");
    print("");
    print("  Quick start:");
    print("    shb gateway start              # Start the HTTP API");
    print("    shb recall \"what do you know about me\"");
    print("    shb reflect stats");
    print("    shb reflect consolidate");
    print("");
    print("  Your AI agent talks to the brain via the gateway API.");
    print("  Default: http://0.0.0.0:18789");
    print("  Run 'shb setup' again anytime to update your profile.\n");
  } catch (e) {
    fail(`Verification failed: ${(e as Error).message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║  SHB — Brain Setup Wizard                ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");
  console.log("  This wizard will set up your persistent AI memory brain.");
  console.log("  It takes about 5 minutes.\n");

  try {
    // Step 1: Prerequisites
    const prereqsOk = await checkPrerequisites();
    if (!prereqsOk) {
      print("\n  Fix the prerequisites above and re-run: shb setup");
      rl.close();
      await disconnect();
      return;
    }

    // Step 2: Database
    const dbOk = await setupDatabase();
    if (!dbOk) {
      print("\n  Fix the database issue above and re-run: shb setup");
      rl.close();
      await disconnect();
      return;
    }

    // Step 3: About You
    await collectPersonalInfo();

    // Step 4: Projects
    await scanProjects();

    // Step 5: Gateway
    await setupGateway();

    // Step 6: Build
    await buildCli();

    // Step 7: Verify
    await verify();
  } catch (e) {
    console.error(`\n  Setup error: ${(e as Error).message}`);
  } finally {
    rl.close();
    await disconnect();
  }
}
