import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    outDir: 'dist-sdk',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'chemical-editor.js' },
  },
});
