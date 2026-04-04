import { readFileSync, writeFileSync, existsSync } from "fs";

const DEDUP_FILE = "/tmp/shb-dedup.json";

interface DedupEntry {
  [hash: string]: number; // timestamp
}

function loadEntries(): DedupEntry {
  try {
    if (existsSync(DEDUP_FILE)) {
      return JSON.parse(readFileSync(DEDUP_FILE, "utf-8"));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return {};
}

function saveEntries(entries: DedupEntry): void {
  writeFileSync(DEDUP_FILE, JSON.stringify(entries));
}

/**
 * Check if content hash was seen within the dedup window.
 * Also cleans up expired entries.
 */
export function isDuplicate(
  hash: string,
  windowMs: number = 300_000 // 5 minutes
): boolean {
  const now = Date.now();
  const entries = loadEntries();

  // Clean expired entries
  for (const [key, ts] of Object.entries(entries)) {
    if (now - ts > windowMs) {
      delete entries[key];
    }
  }

  if (entries[hash] && now - entries[hash] < windowMs) {
    saveEntries(entries);
    return true;
  }

  // Mark as seen
  entries[hash] = now;
  saveEntries(entries);
  return false;
}
