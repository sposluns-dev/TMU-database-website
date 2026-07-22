import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/TMU-database-website/',
  server: {
    // Dev only: send /api/* to the local search service so the browser makes
    // same-origin requests and no CORS config is needed. Production talks to
    // Cloud Run directly via VITE_API_BASE (see .env.example).
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
