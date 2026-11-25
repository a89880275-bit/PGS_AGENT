import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'apps/api-server/mock/web');
const dist = join(root, 'dist/mock');
const modules = process.env.PGS_UI_MODULES;
const require = createRequire(modules ? resolve(modules, 'package.json') : import.meta.url);
const { build } = require('esbuild');
await mkdir(dist, { recursive: true });
for (const asset of ['index.html','style.css']) await cp(join(web, asset), join(dist, asset));

const result = await build({
  absWorkingDir: root, entryPoints: [join(web, 'main.jsx')], bundle: true,
  write: false, format: 'esm', jsx: 'automatic', tsconfigRaw: {},
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: modules ? [{
    name: 'offline-module-resolution',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === '/pdf.mjs') return { path: args.path, external: true };
        const path = args.kind === 'entry-point' ? args.path
          : args.path.startsWith('.') ? createRequire(args.importer).resolve(args.path)
          : require.resolve(args.path);
        return { path, namespace: 'pgs-local' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'pgs-local' }, async args => ({
        contents: await readFile(args.path, 'utf8'),
        loader: args.path.endsWith('.jsx') ? 'jsx' : 'js',
        resolveDir: dirname(args.path),
      }));
    },
  }] : [],
  external: ['/pdf.mjs'],
});
await writeFile(join(dist, 'ui.js'), result.outputFiles[0].contents);
console.log('React Mock bundle built');