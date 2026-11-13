const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// Ensure dist directory exists
if (!fs.existsSync('dist')) fs.mkdirSync('dist');

// Copy static files
const staticFiles = [
  'public/manifest.json',
  'public/offscreen.html',
  'public/offscreen.js',
  'public/shadow.css',
  'public/permission.html',
  'public/permission.js'
];

staticFiles.forEach(file => {
  const dest = path.join('dist', path.basename(file));
  fs.copyFileSync(file, dest);
});

console.log('[Shadow] Static files copied');

async function main() {
  const contentOptions = {
    entryPoints: ['src/content/index.js'],
    bundle: true,
    outfile: 'dist/content.js',
    format: 'iife',
    target: 'chrome100',
  };

  const backgroundOptions = {
    entryPoints: ['src/background/index.js'],
    bundle: true,
    outfile: 'dist/background.js',
    format: 'esm',
    target: 'chrome100',
  };

  if (isWatch) {
    const contentCtx = await esbuild.context(contentOptions);
    const backgroundCtx = await esbuild.context(backgroundOptions);
    await Promise.all([contentCtx.watch(), backgroundCtx.watch()]);
    console.log('[Shadow] Build complete → dist/');
    console.log('[Shadow] Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(contentOptions),
      esbuild.build(backgroundOptions),
    ]);
    console.log('[Shadow] Build complete → dist/');
  }
}

main().catch(err => {
  console.error('[Shadow] Build failed:', err);
  process.exit(1);
});
