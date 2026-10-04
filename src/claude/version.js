'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Read a native install's filename or official npm metadata without executing the binary. */
function versionFromPath(binary) {
  const base = path.basename(binary);
  if (/^\d+\.\d+\.\d+$/.test(base)) return base;
  let dir = path.dirname(binary);
  for (let i = 0; i < 3; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (/^@anthropic-ai\/claude-code(?:-[a-z0-9-]+)?$/.test(pkg.name) && /^\d+\.\d+\.\d+$/.test(pkg.version)) return pkg.version;
    } catch { /* This directory need not contain package metadata. */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

module.exports = { versionFromPath };
