import { defineConfig } from 'vite';
import { rdkitAssets } from './build/rdkit-assets.ts';
export default defineConfig({
  plugins:[rdkitAssets()],
  build: {
    outDir: 'dist-sdk',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'chemical-editor.js' },
  },
});
