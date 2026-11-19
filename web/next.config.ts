import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'

const apiRoutes = ['/health', '/scans', '/snapshots', '/sessions', '/lineages', '/voice']

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const backend = process.env.CODELINEAGE_API_ORIGIN ?? 'http://127.0.0.1:8000'
    return {
      async rewrites() {
        return apiRoutes.map(path => ({
          source: path + '/:rest*',
          destination: backend + path + '/:rest*',
        }))
      },
    }
  }
  return { output: 'export', distDir: 'dist' }
}
