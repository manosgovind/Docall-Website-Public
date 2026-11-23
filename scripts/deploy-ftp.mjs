// Uploads this site to Hostinger over FTP, sending only the files that changed since
// the last deploy from this computer, and removing files that were deleted locally.
//
//   npm run deploy              changed files only
//   npm run deploy -- --all     upload everything again
//   npm run deploy -- --dry     list what would change, upload nothing
//
// Settings come from .env.deploy next to package.json (gitignored, see
// .env.deploy.example). What was uploaded is remembered in .deploy-state.json
// (gitignored); without it — e.g. on another computer — everything is uploaded once.
//
// Only files this script uploaded are ever deleted from the server, so anything
// else in the folder (e.g. the admin portal in /admin/) is left alone.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'basic-ftp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.deploy');
const STATE_FILE = path.join(ROOT, '.deploy-state.json');

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ALL = args.includes('--all');
const DRY = args.includes('--dry');
const LOCAL_DIR = path.resolve(ROOT, option('dir') ?? '.');
// Never uploaded, whatever the project
const EXCLUDE = ['.git', 'node_modules', '.env.deploy', '.env.deploy.example', '.deploy-state.json',
  ...(option('exclude') ?? '').split(',').filter(Boolean)];

// ─── Settings ────────────────────────────────────────────────────────────────

const readEnv = (file) => {
  if (!fs.existsSync(file)) return null;
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
};

const env = readEnv(ENV_FILE);
if (!env) {
  console.error('Missing .env.deploy — copy .env.deploy.example to .env.deploy and fill it in.');
  process.exit(1);
}
const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD', 'FTP_DIR'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Fill ${missing.join(', ')} in .env.deploy`);
  process.exit(1);
}
const REMOTE_DIR = `/${env.FTP_DIR.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const TARGET = `${env.FTP_USER}@${env.FTP_HOST}${REMOTE_DIR}`;

// ─── What changed ────────────────────────────────────────────────────────────

const excluded = (rel) => EXCLUDE.some((p) => rel === p || rel.startsWith(`${p}/`));

const listFiles = (dir, prefix = '') => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excluded(rel)) continue;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
};

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const saved = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
// State from another target (different server/folder) says nothing about this one
const previous = saved?.target === TARGET ? saved.files : {};

const current = {};
for (const rel of listFiles(LOCAL_DIR)) current[rel] = hash(path.join(LOCAL_DIR, rel));

const toUpload = Object.keys(current).filter((rel) => ALL || previous[rel] !== current[rel]);
const toDelete = Object.keys(previous).filter((rel) => !(rel in current));

// Pages last, the home page very last: a visitor never gets a page that points at
// files (e.g. the admin portal's new build) that aren't on the server yet
const rank = (rel) => (rel === 'index.html' ? 2 : rel.endsWith('.html') ? 1 : 0);
toUpload.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

console.log(`\nDeploying ${path.relative(ROOT, LOCAL_DIR) || '.'} → ${env.FTP_HOST}${REMOTE_DIR}`);
console.log(`  ${toUpload.length} to upload, ${toDelete.length} to delete, ${Object.keys(current).length - toUpload.length} unchanged\n`);
if (DRY) {
  toUpload.forEach((rel) => console.log(`  + ${rel}`));
  toDelete.forEach((rel) => console.log(`  - ${rel}`));
  process.exit(0);
}
if (!toUpload.length && !toDelete.length) {
  console.log('Nothing changed ✓');
  process.exit(0);
}

// ─── Upload ──────────────────────────────────────────────────────────────────

const state = { target: TARGET, files: { ...previous } };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const client = new Client(30_000);
try {
  await client.access({
    host: env.FTP_HOST,
    port: Number(env.FTP_PORT) || 21,
    user: env.FTP_USER,
    password: env.FTP_PASSWORD,
    // Encrypted (FTPS) unless FTP_TLS=false. FTP_TLS_INSECURE=true accepts a server
    // certificate that doesn't match FTP_HOST (e.g. when FTP_HOST is an IP address).
    secure: env.FTP_TLS !== 'false',
    secureOptions: env.FTP_TLS_INSECURE === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  let cwd = null;
  for (const rel of toUpload) {
    const dir = path.posix.dirname(rel);
    const remoteDir = dir === '.' ? REMOTE_DIR : `${REMOTE_DIR}${dir}/`;
    if (remoteDir !== cwd) {
      await client.ensureDir(remoteDir);
      cwd = remoteDir;
    }
    await client.uploadFrom(path.join(LOCAL_DIR, rel), path.posix.basename(rel));
    state.files[rel] = current[rel];
    console.log(`  ✓ ${rel}`);
  }
  for (const rel of toDelete) {
    await client.remove(`${REMOTE_DIR}${rel}`, true); // true: fine if it's already gone
    delete state.files[rel];
    console.log(`  ✗ ${rel}`);
  }
  console.log('\nDeployed ✓');
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  if (/certificate|self.signed|altnames/i.test(err.message)) {
    console.error('   The server certificate doesn\'t match FTP_HOST: use the FTP host name from hPanel, or set FTP_TLS_INSECURE=true.');
  }
  console.error('   Files uploaded so far are remembered — run the deploy again to continue.');
  process.exitCode = 1;
} finally {
  saveState();
  client.close();
}
