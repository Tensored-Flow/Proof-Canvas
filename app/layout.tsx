import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import 'katex/dist/katex.min.css'
import './globals.css'
import './proofcanvas.css'

export const metadata: Metadata = {
  title: 'ProofCanvas — Mathematical animation editor',
  description: 'A structured, style-first editor for mathematical animation and readable Manim export.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3eedf',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  )
}
