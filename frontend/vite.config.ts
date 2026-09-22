import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
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
    // REGRESSION GUARD (#679): never 'esnext'. That shipped whatever syntax
    // the source and its dependencies used, untranspiled -- class fields, and
    // a class static block (Safari 16.4+) that esbuild itself emits for Radix.
    // One unparseable token and the single ES module does not run, so an older
    // macOS web view showed a blank window. The floor is Safari 15.4, not 15:
    // the bundle calls Object.hasOwn and Array.prototype.at, which a syntax
    // target cannot transpile. Keep `minimumSystemVersion` in tauri.conf.json
    // (10.15, the oldest macOS that gets Safari 15.4) in step with this.
    // See src/__tests__/startupFailure.test.ts.
    target: ['safari15', 'chrome105'],
    // Tauri loads this bundle from local disk over file://, not over the
    // network, so the default 500 kB warning is measuring a cost we don't
    // pay. Raised above the current ~990 kB entry chunk with headroom, but
    // deliberately not set high enough to stop flagging a real jump. See
    // issue #259.
    chunkSizeWarningLimit: 1200,
  },
  // Environment variables
  define: {
    __TAURI__: process.env.TAURI === 'true',
    // Surface the package version to the UI so the About panel doesn't drift
    // from the real version. See issue #149.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
