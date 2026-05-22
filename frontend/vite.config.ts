import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

function fixCampfireSpacing() {
  const patch = (code: string) => code.replace(/--spacing\((\d+)\)/g, 'calc(var(--spacing) * $1)');

  return {
    name: 'campfire-spacing-fix',
    enforce: 'pre' as const,
    async load(id: string) {
      if (
        id.includes('@jeremyfuksa/campfire/dist/index.css') ||
        id.includes('@jeremyfuksa/campfire/styles.css')
      ) {
        const code = await fs.promises.readFile(id, 'utf-8');
        return patch(code);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    fixCampfireSpacing(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Base path for Tauri (served from file:// protocol in production)
  base: process.env.TAURI === 'true' ? './' : '/',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
        // changeOrigin rewrites the Host header to localhost:8000 so the
        // backend's Host allowlist accepts the proxied upgrade. Without it
        // the browser's Host (localhost:5173) propagates through and gets
        // rejected as a potential DNS-rebinding target.
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
  // Environment variables
  define: {
    __TAURI__: process.env.TAURI === 'true',
  },
});
