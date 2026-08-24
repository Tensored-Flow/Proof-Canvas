import { redirect } from 'next/navigation'
import { ProofCanvasAuthError, authenticatedPageSession } from '@/lib/proofcanvas/auth.server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ProofCanvasCompatibilityPage() {
  try {
    await authenticatedPageSession()
    redirect('/')
  } catch (error) {
    if (error instanceof ProofCanvasAuthError && error.code === 'unauthorized') redirect('/login')
    throw error
  }
}
