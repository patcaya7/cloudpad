import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [updaterDirectory = 'updater', outputFile = 'latest.json'] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;

if (!repository || !tag) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_REF_NAME are required to create the update manifest.');
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = await readdir(path.resolve(root, updaterDirectory));
const updateFile = files.find((file) => file.endsWith('.nsis.zip'));

if (!updateFile) throw new Error('No NSIS updater archive was found.');

const signature = (await readFile(path.resolve(root, updaterDirectory, `${updateFile}.sig`), 'utf8')).trim();
const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(updateFile)}`;
const manifest = {
  version: packageJson.version,
  notes: `CloudPad ${packageJson.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { url, signature }
  }
};

await writeFile(path.resolve(root, outputFile), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
