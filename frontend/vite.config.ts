import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function fixCampfireSpacing() {
  const patch = (code: string) => code.replace(/--spacing\((\d+)\)/g, 'calc(var(--spacing) * $1)')

  return {
    name: 'campfire-spacing-fix',
    enforce: 'pre' as const,
    async load(id: string) {
      if (
        id.includes('@jeremyfuksa/campfire/dist/index.css') ||
        id.includes('@jeremyfuksa/campfire/styles.css')
      ) {
        const code = await fs.promises.readFile(id, 'utf-8')
        return patch(code)
      }
    },
  }
}

function mockTauriAPI() {
  return {
    name: 'mock-tauri-api',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === '@tauri-apps/api/core') {
        return {
          id: '@tauri-apps/api/core',
          external: false,
        }
      }
      if (id.startsWith('@tauri-apps/')) {
        return {
          id,
          external: false,
        }
      }
    },
    load(id: string) {
      if (id === '@tauri-apps/api/core') {
        return 'export const invoke = () => Promise.reject(new Error("Tauri API not available"));'
      }
      if (id.startsWith('@tauri-apps/')) {
        return 'export {}'
      }
    },
  }
}

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    fixCampfireSpacing(),
    tailwindcss(),
    // Mock Tauri API when not building for Tauri
    process.env.TAURI !== 'true' ? mockTauriAPI() : null,
  ].filter(Boolean),
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
})
