import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
  // Keep dependencies external so consumers install them.
  external: [
    '@google/genai',
    '@modelcontextprotocol/sdk',
    'execa',
    'ollama',
    'openai',
    'uuid',
    'zod',
    'zod-to-json-schema',
  ],
});
