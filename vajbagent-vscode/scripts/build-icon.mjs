#!/usr/bin/env node
/**
 * Generiše media/icon.png iz media/icon.svg — 256x256, providna pozadina.
 * Pokretanje: node scripts/build-icon.mjs   (iz root-a vajbagent-vscode)
 */
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'media', 'icon.svg');
const pngPath = path.join(root, 'media', 'icon.png');

await sharp(svgPath)
  .resize(256, 256)
  .png()
  .toFile(pngPath);

console.log('OK: media/icon.png (256x256, transparent)');
