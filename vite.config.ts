import { defineConfig } from 'vitest/config';
import { createAiMiddleware } from './server/ai-middleware.mjs';
const aiGateway = createAiMiddleware();
export default defineConfig({
  plugins: [{ name: 'molecule-ai-gateway', configureServer(server) { server.middlewares.use(aiGateway); }, configurePreviewServer(server) { server.middlewares.use(aiGateway); } }],
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
  server: { port: 5173, strictPort: true },
});
