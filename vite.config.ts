import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')
) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Baked in at build time so the What's New panel (and anything else that needs
  // the current version) works identically in the browser and in the Tauri app,
  // without an async IPC call to @tauri-apps/api/app's getVersion().
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      output: {
        // Split large, independent vendor libraries into their own chunks so a
        // single edit to app code doesn't invalidate the cache for all of them,
        // and the "chunk larger than 500kB" bundle stays out of the main chunk.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-codemirror': [
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/search',
            '@codemirror/state',
            '@codemirror/view'
          ],
          'vendor-supabase': ['@supabase/supabase-js']
        }
      }
    }
  }
});
