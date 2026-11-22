#!/usr/bin/env node

/**
 * oauth-bridge-package.mjs: zips packages/oauth-bridge-extension for the Chrome Web Store into
 * dist/omniroute-oauth-bridge-<version>.zip. Ships manifest.json, approve.html, bridge.html and
 * src/** only (no README, no tests, no dotfiles). Dependency-free: stored with zlib deflate.
 *
 * Usage: node scripts/build/oauth-bridge-package.mjs [--out <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT_DIR = path.join(ROOT, "packages", "oauth-bridge-extension");
const TOP_LEVEL_FILES = ["manifest.json", "approve.html", "bridge.html"];
const EXCLUDED = /(^|\/)(\.[^/]*|[^/]*\.test\.[^/]+|README\.md)$/;

/** Relative paths (posix) of every file that goes into the store zip, sorted. */
export function listPackageFiles(extDir = EXT_DIR) {
  const out = [...TOP_LEVEL_FILES];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(extDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (EXCLUDED.test(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("src");
  for (const f of out) {
    if (!fs.existsSync(path.join(extDir, f))) throw new Error(`missing ${f}`);
  }
  return out.sort();
}

// Fixed DOS timestamp (1980-01-01 00:00) so the same sources always give the same zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Builds a zip archive (deflate) from [{name, data: Buffer}]. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/**
 * Writes the store zip. The `key` field is removed from the packaged manifest: the Chrome Web
 * Store rejects uploads that carry one and assigns its own ID.
 * @returns {{file: string, files: string[]}}
 */
export function packageExtension({ outDir = path.join(ROOT, "dist"), extDir = EXT_DIR } = {}) {
  const files = listPackageFiles(extDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  const { key: _key, ...storeManifest } = manifest;
  const entries = files.map((name) => ({
    name,
    data:
      name === "manifest.json"
        ? Buffer.from(JSON.stringify(storeManifest, null, 2) + "\n")
        : fs.readFileSync(path.join(extDir, name)),
  }));
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `omniroute-oauth-bridge-${manifest.version}.zip`);
  fs.writeFileSync(file, buildZip(entries));
  return { file, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--out");
  const outDir = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
  const { file, files } = packageExtension(outDir ? { outDir } : {});
  console.log(`oauth-bridge: wrote ${path.relative(ROOT, file)} (${files.length} files)`);
}
