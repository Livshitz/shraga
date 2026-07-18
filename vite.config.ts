import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';

// HTTPS dev server (default). Browsers only expose powerful APIs (mic, camera, clipboard) in a
// secure context (HTTPS, or localhost), so a phone on the LAN needs HTTPS. basic-ssl mints a
// self-signed cert — accept the one-time warning on the device. Opt out with `DEV_HTTPS=0`.
const httpsDev = process.env.DEV_HTTPS !== '0';

export default defineConfig({
  plugins: [react(), ...(httpsDev ? [basicSsl()] : [])],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: true,
    // Add-on packages may be symlinked to sibling repos OUTSIDE this project root; vite's default
    // fs.allow (project root only) would 403 their source in dev. Allow the parent dir so
    // symlinked dev packages serve. Dev-only; prod bundles them.
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: (() => {
      // Backend port — overridable so a second dev stack can run on its own ports (DEV_SERVER_PORT).
      const p = process.env.DEV_SERVER_PORT || '3033';
      return {
        '/api': `http://localhost:${p}`,
        '/uploads': `http://localhost:${p}`,
        '/ws': { target: `ws://localhost:${p}`, ws: true },
        '/pty': { target: `ws://localhost:${p}`, ws: true },
      };
    })(),
  },
});
