import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const errors = [];
const skip = new Set(['.git', 'node_modules', 'dist', 'coverage']);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) { errors.push(`Symlink is not allowed: ${path.relative(root, full)}`); return []; }
    return entry.isDirectory() ? walk(full) : [path.relative(root, full)];
  });
}
let files;
try {
  // Include newly staged files and ignore generated local artifacts.
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: 'pipe' });
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch { files = walk(root).filter(file => !/^evaluation\/(?!README\.md$|korean-memory\.json$|gameplay-graph\.fixture\.json$)/.test(file)); }
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.name !== 'memory2' || lock.name !== pkg.name || lock.packages[''].name !== pkg.name || lock.version !== pkg.version) errors.push('Package identity or lockfile version mismatch');
for (const required of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'NOTICE.md', 'SECURITY.md', 'CHANGELOG.md', '.github/workflows/ci.yml', 'docs/README.md']) {
  if (!files.includes(required)) errors.push(`Missing repository file: ${required}`);
}
for (const file of files) {
  if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:db(?:-wal|-shm)?|sqlite3?|key|pem|zip))$/.test(file) && file !== '.env.example') errors.push(`Forbidden local or secret file: ${file}`);
  if (!fs.existsSync(path.join(root, file))) { errors.push(`Missing tracked file: ${file}`); continue; }
  const data = fs.readFileSync(path.join(root, file));
  if (data.length > 3 * 1024 * 1024) errors.push(`Oversized file: ${file}`);
  if (/\.png$/.test(file)) continue;
  const text = (file.endsWith('.gz') ? gunzipSync(data) : data).toString('utf8');
  if (/sk-or-v1-[a-f0-9]{32,}|github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) errors.push(`Possible credential in: ${file}`);
  if (!file.endsWith('.md')) continue;
  // Links in fenced command examples are not document navigation.
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    let relative;
    try { relative = decodeURIComponent(target.split('#')[0]); } catch { errors.push(`Invalid link encoding: ${file}`); continue; }
    relative = relative.replace(/:\d+$/, '');
    if (relative && !fs.existsSync(path.resolve(root, path.dirname(file), relative))) errors.push(`Broken link: ${file} -> ${relative}`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Repository checks passed (${files.length} files; metadata, local links and credential patterns).`);
