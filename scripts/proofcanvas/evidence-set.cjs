'use strict'

const EXPECTED_TEMPORARY_EVIDENCE_ENTRIES = Object.freeze([
  'browser-stress-verification.json',
  'landscape-video-verification.json',
  'portrait-video-verification.json',
  'proofcanvas-blank-editor-1920x1080.png',
  'proofcanvas-ai-proposal-review-1920x1080.png',
  'proofcanvas-animation-inspector-1920x1080.png',
  'proofcanvas-dashboard-1920x1080.png',
  'proofcanvas-editorial-1280x800.png',
  'proofcanvas-editorial-1440x900.png',
  'proofcanvas-editorial-1920x1080.png',
  'proofcanvas-narrow-editor-1024x768.png',
  'proofcanvas-portrait-output-1440x900.png',
  'proofcanvas-render-dialog-1440x900.png',
  'proofcanvas-selected-graph-1920x1080.png',
  'proofcanvas-selected-text-1920x1080.png',
  'proofcanvas-style-lab-1920x1080.png',
  'proofcanvas-style-nocturne-chalk-1920x1080.png',
  'proofcanvas-style-scientific-minimal-1920x1080.png',
  'proofcanvas-timeline-keyframes-1920x1080.png',
  'report.json',
  'restart-report.json',
  'still-verification.json',
  'ui-download/',
  'ui-download/proofcanvas-portrait-480x854-24fps.mp4',
  'ui-download/proofcanvas-render.mp4',
  'ui-download/proofcanvas-still-current.png',
  'ui-download/proofcanvas-v1-roundtrip.proofcanvas',
].sort())

function requireExactTemporaryEvidenceEntries(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('ProofCanvas browser evidence rejected: temporary evidence entry set is malformed')
  }
  const actual = [...entries].sort()
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_TEMPORARY_EVIDENCE_ENTRIES)) {
    throw new Error('ProofCanvas browser evidence rejected: temporary run must contain exactly the expected recursive entry set')
  }
  return actual
}

module.exports = { EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, requireExactTemporaryEvidenceEntries }
