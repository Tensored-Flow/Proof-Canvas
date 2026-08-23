import ProofCanvasEditor from './ProofCanvasEditor'

export const dynamic = 'force-dynamic'

export default function ProofCanvasPage() {
  const aiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.PROOFCANVAS_OPENAI_MODEL?.trim())
  return <ProofCanvasEditor aiConfigured={aiConfigured} />
}
