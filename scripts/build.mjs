#!/usr/bin/env node
import { cpSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });

for (const browser of ['chrome', 'firefox']) {
    const out = join(dist, browser);
    mkdirSync(out, { recursive: true });
    cpSync(join(root, 'src'), join(out, 'src'), { recursive: true });
    copyFileSync(
        join(root, browser === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'),
        join(out, 'manifest.json'),
    );
    console.log(`built ${out}`);
}
