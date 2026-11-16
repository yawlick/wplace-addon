#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SITE = new URL(process.argv[2] ?? 'https://wplace.live/');
const OUTPUT = join(import.meta.dirname, 'snapshot');
const queue = [];
const queued = new Set();
const downloaded = new Map();

function enqueue(value, parent = SITE) {
  const url = new URL(value, parent);
  if (url.origin !== SITE.origin || !url.pathname.endsWith('.js')) return;
  url.hash = '';
  if (!queued.has(url.href)) {
    queued.add(url.href);
    queue.push(url);
  }
}

function localPath(url) {
  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return join(OUTPUT, cleanPath || 'index.js');
}

function discoverImports(source, parent) {
  const patterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    // Vite keeps lazy-loaded route chunks in __vite__mapDeps string arrays.
    /["'](\.\.\/chunks\/[^"']+\.js(?:\?[^"']*)?)["']/g,
    /new\s+URL\s*\(\s*["']([^"']+\.js(?:\?[^"']*)?)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) enqueue(match[1], parent);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'wplace-addon-dev-snapshot/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });

  const html = await fetchText(SITE);
  await writeFile(join(OUTPUT, 'index.html'), html, 'utf8');

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/g)) {
    enqueue(match[1], SITE);
  }

  while (queue.length > 0) {
    const url = queue.shift();
    const source = await fetchText(url);
    const path = localPath(url);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, 'utf8');
    discoverImports(source, url);

    downloaded.set(url.href, {
      file: path.slice(OUTPUT.length + 1).replaceAll('\\', '/'),
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    process.stdout.write(`Downloaded ${url.pathname}\n`);
  }

  const manifest = {
    source: SITE.href,
    downloadedAt: new Date().toISOString(),
    files: Object.fromEntries([...downloaded.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nSaved ${downloaded.size} JavaScript files to ${OUTPUT}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
