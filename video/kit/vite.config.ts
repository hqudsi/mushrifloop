import { defineConfig } from 'vite';

// Relative base: the built page is served from a local folder by the render scripts.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
    // Two pages: the video, and the style toolkit's own test scene (used only by `npm test`).
    rollupOptions: {
      input: { index: 'index.html', 'style-test': 'style-test.html' },
    },
  },
});
