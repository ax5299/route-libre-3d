import { defineConfig } from 'vite';

// Base relative : le build statique de dist/ peut être servi depuis n'importe
// quel sous-dossier (Vercel, GitHub Pages, simple serveur fichier).
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
