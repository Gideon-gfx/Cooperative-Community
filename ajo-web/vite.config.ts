import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../ajo-backend/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/files': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
    },
  },
})
