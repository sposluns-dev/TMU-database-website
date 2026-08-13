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
        // 127.0.0.1, NOT localhost. On macOS `localhost` resolves to ::1 first,
        // while `uvicorn --host 127.0.0.1` (the documented way to run the
        // backend) listens on IPv4 only — so the proxy connects to nothing and
        // every /api call comes back 500 with no hint as to why.
        target: process.env.DEV_API_TARGET ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
