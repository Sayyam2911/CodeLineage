import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '@fontsource-variable/geist'
import '../src/styles.css'

export const metadata: Metadata = {
  title: 'CodeLineage',
  description: 'Trace the architecture of a repository to its source and record the reasoning behind it.',
}

export const viewport: Viewport = {
  themeColor: '#141716',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className="dark"><body>{children}</body></html>
}
