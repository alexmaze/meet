#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (options.stdio === "inherit" || (Array.isArray(options.stdio) && options.stdio[1] === "inherit")) {
    return "";
  }
  return String(result).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpPatch(version) {
  const parsed = parseSemver(version);
  if (!parsed) fail(`当前版本不是合法 semver：${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function packageJsonPaths() {
  const paths = [join(root, "package.json")];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group);
    for (const name of readdirSync(groupDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      paths.push(join(groupDir, name.name, "package.json"));
    }
  }
  return paths;
}

function readVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function writeVersion(path, version) {
  const packageJson = JSON.parse(readFileSync(path, "utf8"));
  packageJson.version = version;
  writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function tagExists(tag) {
  try {
    run("git", ["rev-parse", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 128) {
      return false;
    }
    throw error;
  }
}

const status = run("git", ["status", "--porcelain"]);
if (status) fail("工作区不干净，请先提交或暂存变更后再 release。");

const rootPackagePath = join(root, "package.json");
const currentVersion = readVersion(rootPackagePath);
const requested = process.argv[2];
const nextVersion = requested ? requested.replace(/^v/, "") : bumpPatch(currentVersion);

if (!parseSemver(nextVersion)) {
  fail(`版本不合法，期望 X.Y.Z，收到：${requested ?? nextVersion}`);
}

if (requested && nextVersion === currentVersion) {
  fail(`指定版本与当前版本相同：${currentVersion}`);
}

const tag = `v${nextVersion}`;
if (tagExists(tag)) fail(`tag 已存在：${tag}`);

const paths = packageJsonPaths();
for (const path of paths) {
  const existing = readVersion(path);
  if (existing !== currentVersion) {
    fail(`${relative(root, path)} 版本为 ${existing}，与根版本 ${currentVersion} 不一致。`);
  }
  writeVersion(path, nextVersion);
}

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (!branch || branch === "HEAD") {
  fail("当前不在具名分支上，无法 push release。");
}

run(
  "git",
  ["add", ...paths.map((path) => relative(root, path))],
  { stdio: "inherit" },
);
run("git", ["commit", "-m", `chore: release ${tag}`], { stdio: "inherit" });
run("git", ["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" });
run("git", ["push", "origin", `HEAD:${branch}`], { stdio: "inherit" });
run("git", ["push", "origin", tag], { stdio: "inherit" });

console.log(`已发布 ${tag}，并推送到 origin（将触发镜像构建）。`);
