import { createHash } from 'node:crypto'
import { REQUIRED_AI_COMMANDS, interpretDemoCommand } from '../../lib/proofcanvas/ai'
import { commitOperations, createHistory, undo } from '../../lib/proofcanvas/history'
import { canonicalProjectJson, type ProjectDocument } from '../../lib/proofcanvas/schema'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function contentSignature(project: ProjectDocument, shotId: string) {
  const shot = project.shots.find(({ id }) => id === shotId)!
  return Object.fromEntries(shot.objects.map(({ id, properties }) => [id, properties.content ?? null]))
}

/** Regenerate the exact deterministic AI evidence retained for the canonical example. */
export function generateAiCommandEvidence(project: ProjectDocument) {
  const shotId = 'shot-cantor-construction'
  return REQUIRED_AI_COMMANDS.map((command, index) => {
    const beforeJson = canonicalProjectJson(project)
    const proposal = interpretDemoCommand({ project, shotId, selectedObjectIds: [], instruction: command })
    const committed = commitOperations(createHistory(project), shotId, proposal.operations, `AI: ${proposal.intention}`)
    const after = committed.present
    const afterShot = after.shots.find(({ id }) => id === shotId)!
    const undone = undo(committed)
    if (committed.past.length !== 1 || canonicalProjectJson(undone.present) !== beforeJson) {
      throw new Error(`Required AI command ${index + 1} was not one atomic, reversible transaction`)
    }

    let semanticEvidence: Record<string, unknown>
    if (index === 0) {
      const title = afterShot.objects.find(({ id }) => id === 'object-title')!
      const beforeDiagram = project.shots[0].objects.filter(({ id, parentId }) => id === 'object-interval-diagram' || parentId === 'object-interval-diagram')
      const afterDiagram = afterShot.objects.filter(({ id, parentId }) => id === 'object-interval-diagram' || parentId === 'object-interval-diagram')
      semanticEvidence = { titlePosition: { x: title.transform.x, y: title.transform.y }, intervalDiagramUnchanged: JSON.stringify(beforeDiagram) === JSON.stringify(afterDiagram) }
    } else if (index === 1) {
      const beforeRemoval = project.shots[0].animations.find(({ id }) => id === 'animation-second-removal')!
      const afterRemoval = afterShot.animations.find(({ id }) => id === 'animation-second-removal')!
      const emphasis = afterShot.animations.find(({ id }) => id.includes('second-removal-emphasis'))!
      semanticEvidence = { durationBefore: beforeRemoval.duration, durationAfter: afterRemoval.duration, easingAfter: afterRemoval.easing, emphasisAnimationId: emphasis.id, emphasisEndsBeforeRemoval: emphasis.start + emphasis.duration <= afterRemoval.start }
    } else if (index === 2) {
      const brace = afterShot.objects.find(({ semanticRole }) => semanticRole === 'surviving-intervals-brace')!
      const reveal = afterShot.animations.find(({ targetIds }) => targetIds.includes(brace.id))!
      const thirdRemovals = afterShot.animations.find(({ id }) => id === 'animation-third-removals')!
      semanticEvidence = { braceId: brace.id, label: brace.properties.label, revealAnimationId: reveal.id, revealStart: reveal.start, thirdRemovalsEnd: thirdRemovals.start + thirdRemovals.duration, revealAfterThirdRemoval: reveal.start > thirdRemovals.start + thirdRemovals.duration }
    } else if (index === 3) {
      const beforePositions = new Map(project.shots[0].objects.map(({ id, transform }) => [id, `${transform.x},${transform.y}`]))
      semanticEvidence = { activeStyleId: after.activeStyleId, mathematicalContentUnchanged: JSON.stringify(contentSignature(after, shotId)) === JSON.stringify(contentSignature(project, shotId)), repositionedObjectCount: afterShot.objects.filter(({ id, transform }) => beforePositions.get(id) !== `${transform.x},${transform.y}`).length }
    } else {
      const equationIds = new Set(['object-equation-chain', ...afterShot.objects.filter(({ parentId }) => parentId === 'object-equation-chain').map(({ id }) => id)])
      const supporting = afterShot.objects.filter(({ id }) => !equationIds.has(id))
      semanticEvidence = { equationFamilyLocked: afterShot.objects.filter(({ id }) => equationIds.has(id)).every(({ locked }) => locked), quietedObjectCount: supporting.filter(({ style }) => (style.opacity ?? 1) <= 0.82).length, supportingObjectCount: supporting.length }
    }

    return {
      commandNumber: index + 1,
      command,
      provider: proposal.provider,
      intention: proposal.intention,
      summary: proposal.summary,
      operations: proposal.operations,
      operationCount: proposal.operations.length,
      beforeProjectSha256: sha256(beforeJson),
      afterProjectSha256: sha256(canonicalProjectJson(after)),
      historyEntries: committed.past.length,
      undoRestoredExactProject: true,
      semanticEvidence,
    }
  })
}
