import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = 'http://127.0.0.1:8000'
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(['/health', '/scans', '/snapshots', '/sessions', '/lineages', '/voice'].map(path => [path, api])),
  },
})
