import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['ext-dist/hud/src/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  logLevel: 'warning',
  outfile: 'ext-dist/hud/hud.js',
});
