import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestUrl = process.env.CLOUDPAD_UPDATE_MANIFEST_URL
  ?? (process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/latest/download/latest.json`
    : '');

if (!/^https:\/\//i.test(manifestUrl)) {
  throw new Error('Set CLOUDPAD_UPDATE_MANIFEST_URL to a public HTTPS latest.json URL before building an update release.');
}

const publicKey = (await readFile(path.join(root, 'src-tauri', 'updater-public-key.txt'), 'utf8')).trim();
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey: publicKey,
      endpoints: [manifestUrl],
      windows: { installMode: 'passive' }
    }
  }
};

await writeFile(
  path.join(root, 'src-tauri', 'tauri.updater.generated.conf.json'),
  `${JSON.stringify(config, null, 2)}\n`,
  'utf8'
);
