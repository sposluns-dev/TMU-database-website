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
    //
    // DEV_API_TARGET repoints this at a remote backend (e.g. the deployed Cloud
    // Run URL) when you want to work on the UI without running server/app.py.
    // Still proxied, so it stays same-origin and CORS never applies.
    proxy: {
      '/api': {
        target: process.env.DEV_API_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
