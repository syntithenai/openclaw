#!/usr/bin/env node
import path from "node:path";

/**
 * Prints selected files as NUL-delimited tokens to stdout.
 *
 * Usage:
 *   node scripts/pre-commit/filter-staged-files.mjs lint -- <files...>
 *   node scripts/pre-commit/filter-staged-files.mjs format -- <files...>
 *
 * Keep this dependency-free: the pre-commit hook runs in many environments.
 */

const mode = process.argv[2];
const rawArgs = process.argv.slice(3);
const files = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

if (mode !== "lint" && mode !== "format") {
  process.stderr.write("usage: filter-staged-files.mjs <lint|format> -- <files...>\n");
  process.exit(2);
}

const lintExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const formatExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx"]);

const formatIgnorePrefixes = [
  "apps/",
  "assets/",
  "dist/",
  "docs/_layouts/",
  "node_modules/",
  "patches/",
  "src/auto-reply/reply/export-html/",
  "Swabble/",
  "vendor/",
];
const formatIgnoreExact = new Set(["docker-compose.yml"]);

const isFormatIgnored = (filePath) => {
  if (formatIgnoreExact.has(filePath)) {
    return true;
  }
  return formatIgnorePrefixes.some((prefix) => filePath.startsWith(prefix));
};

const shouldSelect = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (mode === "lint") {
    return lintExts.has(ext);
  }
  if (!formatExts.has(ext)) {
    return false;
  }
  return !isFormatIgnored(filePath);
};

for (const file of files) {
  if (shouldSelect(file)) {
    process.stdout.write(file);
    process.stdout.write("\0");
  }
}
