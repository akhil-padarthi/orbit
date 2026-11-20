/**
 * Bundles the React app with esbuild into client/dist.
 *   node scripts/build-client.js           production build (minified, hashed file names)
 *   node scripts/build-client.js --watch   rebuild on change (development)
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'client', 'dist');
const watch = process.argv.includes('--watch');

function writeIndex(metafile) {
  const outputs = Object.keys(metafile.outputs).map((f) => '/' + path.relative(outdir, path.join(root, f)).split(path.sep).join('/'));
  const js = outputs.find((f) => f.endsWith('.js'));
  const css = outputs.find((f) => f.endsWith('.css'));
  const template = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  const html = template
    .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="${css}">` : '')
    .replace('<!--JS-->', `<script type="module" src="${js}"></script>`);
  fs.writeFileSync(path.join(outdir, 'index.html'), html);
  fs.copyFileSync(path.join(root, 'client', 'favicon.svg'), path.join(outdir, 'favicon.svg'));
}

const options = {
  entryPoints: [path.join(root, 'client', 'src', 'main.jsx')],
  bundle: true,
  outdir: path.join(outdir, 'assets'),
  entryNames: watch ? '[name]' : '[name]-[hash]',
  format: 'esm',
  jsx: 'automatic',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  minify: !watch,
  sourcemap: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
  plugins: [{ name: 'index-html', setup(build) { build.onEnd((r) => r.metafile && writeIndex(r.metafile)); } }],
};

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(path.join(outdir, 'assets'), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
