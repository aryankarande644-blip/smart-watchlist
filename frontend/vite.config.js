import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Local dev convenience only — prod build uses VITE_API_BASE_URL directly.
      '/watchlist': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
});
