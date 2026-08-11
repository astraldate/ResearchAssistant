import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function requireMatch(content, pattern, label) {
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`无法从 ${label} 读取版本。`);
  }
  return match[1];
}

function argumentValue(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) {
    return process.argv[exactIndex + 1];
  }
  const prefix = `${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const rootPackage = readJson("package.json");
const mobilePackage = readJson("mobile-app/package.json");
const contractsPackage = readJson("packages/contracts/package.json");
const mobileApp = readJson("mobile-app/app.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoToml = readText("src-tauri/Cargo.toml");
const cargoLock = readText("src-tauri/Cargo.lock");
const androidGradle = readText("mobile-app/android/app/build.gradle");

const expectedVersion = rootPackage.version;
const versions = [
  ["根 package.json", rootPackage.version],
  ["共享协议 package.json", contractsPackage.version],
  ["移动端 package.json", mobilePackage.version],
  ["Expo app.json", mobileApp.expo.version],
  ["Tauri 配置", tauriConfig.version],
  [
    "Cargo.toml",
    requireMatch(
      cargoToml,
      /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
      "Cargo.toml",
    ),
  ],
  [
    "Cargo.lock",
    requireMatch(
      cargoLock,
      /\[\[package\]\]\s*\r?\nname = "researchassistant"\s*\r?\nversion = "([^"]+)"/,
      "Cargo.lock",
    ),
  ],
  [
    "Android versionName",
    requireMatch(androidGradle, /versionName\s+"([^"]+)"/, "Android Gradle"),
  ],
];

const mismatches = versions.filter(
  ([, version]) => version !== expectedVersion,
);
const gradleVersionCode = Number(
  requireMatch(androidGradle, /versionCode\s+(\d+)/, "Android Gradle"),
);
const expoVersionCode = Number(mobileApp.expo.android.versionCode);

if (!Number.isInteger(gradleVersionCode) || gradleVersionCode <= 0) {
  throw new Error("Android Gradle versionCode 必须是正整数。");
}
if (expoVersionCode !== gradleVersionCode) {
  mismatches.push([
    "Android versionCode",
    `app.json=${expoVersionCode}, build.gradle=${gradleVersionCode}`,
  ]);
}

const requestedTag =
  argumentValue("--tag") ??
  (process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined);
if (requestedTag && requestedTag !== `v${expectedVersion}`) {
  mismatches.push(["Git 标签", `${requestedTag}，预期 v${expectedVersion}`]);
}

if (mismatches.length > 0) {
  console.error(`版本一致性检查失败，基准版本为 ${expectedVersion}：`);
  for (const [label, value] of mismatches) {
    console.error(`- ${label}: ${value}`);
  }
  process.exit(1);
}

console.log(
  `版本一致性检查通过：${expectedVersion}，Android versionCode ${gradleVersionCode}${requestedTag ? `，标签 ${requestedTag}` : ""}。`,
);
