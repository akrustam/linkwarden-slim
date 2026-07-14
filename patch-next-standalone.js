#!/usr/bin/env node
/**
 * Patch apps/web/next.config.js for Next.js standalone output.
 * Idempotent. Used only at image build time against upstream sources.
 */
const fs = require("fs");
const path = require("path");

const configPath = path.join("apps", "web", "next.config.js");
if (!fs.existsSync(configPath)) {
  console.error(`missing ${configPath}`);
  process.exit(1);
}

let src = fs.readFileSync(configPath, "utf8");

if (!src.includes("outputFileTracingRoot") && !src.includes('require("path")') && !src.includes("require('path')")) {
  src = `const path = require("path");\n${src}`;
}

if (!src.includes("output: \"standalone\"") && !src.includes("output: 'standalone'")) {
  src = src.replace(
    /const nextConfig = \{/,
    `const nextConfig = {\n  output: "standalone",\n  outputFileTracingRoot: path.join(__dirname, "../../"),`,
  );
}

if (!src.includes("outputFileTracingRoot")) {
  console.error("failed to inject outputFileTracingRoot");
  process.exit(1);
}
if (!src.includes('output: "standalone"') && !src.includes("output: 'standalone'")) {
  console.error("failed to inject output: standalone");
  process.exit(1);
}

fs.writeFileSync(configPath, src);
console.log(`patched ${configPath} for standalone`);
