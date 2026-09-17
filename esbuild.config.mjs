import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import process from 'node:process';

const production = process.argv[2] === 'production';

/**
 * Obsidian loads a plugin as a single CommonJS `main.js`. Everything it already
 * provides — the app API, CodeMirror, Electron — must stay external or the
 * bundle ships a second copy and the editor extensions stop matching the ones
 * Obsidian itself is using.
 */
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: false,
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
