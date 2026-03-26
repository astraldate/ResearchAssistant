import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const conflictPattern = /^(<<<<<<< |=======|>>>>>>> )/m;

function isProbablyBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

const output = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
  {
    encoding: "utf8",
  },
);

const files = output
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);

const conflicted = [];

for (const file of files) {
  try {
    const raw = readFileSync(file);
    if (isProbablyBinary(raw)) {
      continue;
    }
    const content = raw.toString("utf8");
    if (conflictPattern.test(content)) {
      conflicted.push(file);
    }
  } catch {
    // Ignore unreadable or binary files.
  }
}

if (conflicted.length > 0) {
  console.error("Commit blocked: conflict markers found in staged files.");
  for (const file of conflicted) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}
