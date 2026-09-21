import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Test-only: an endpoint that holds requests open, so the tunnel suite can
// probe Cloudflare's in-flight request cap.
const slow = {
  name: 'slow',
  configureServer(server) {
    server.middlewares.use('/__slow', (req, res) => setTimeout(() => res.end('ok'), 4000))
  },
}

export default defineConfig({ plugins: [react(), slow] })
