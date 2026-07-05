import type { DesignHtmlQualityAuditInput, DesignHtmlQualityFinding } from './types'
import type { DesignHtmlQualityStaticAuditContext } from './static-audit-types'
import { deadAnchorTags, genericDialogTitleTags, genericSectionHeadingTags, hasFirstScreenSupportContent, hasFixedDesktopFrame, hasGenericActionCopy, hasInteractionStateAffordance, hasInteractiveControls, hasMissingLayoutReset, hasScriptedInteraction, hasStaticPrimaryAction, hasTopLevelHeading, hasUsefulAnchorTarget, hasWeakTypeHierarchy, hasWeakTypographyConstraints, isGenericPageHeading, isMetaPageHeading, pushFinding, topLevelHeadingTexts, unlabeledFieldTags, weakDestructiveActionSafetyTags, weakDialogAffordanceTags, weakFormAffordanceTags } from './helper-index'

export function auditLayoutAndInteractionQuality(
  _input: DesignHtmlQualityAuditInput,
  ctx: DesignHtmlQualityStaticAuditContext,
  findings: DesignHtmlQualityFinding[]
): void {
  const { normalized, styles, visibleText } = ctx
    if (hasFixedDesktopFrame(styles)) {
      pushFinding(findings, {
        code: 'fixed-desktop-frame',
        severity: 'warning',
        message: 'The page appears locked to a fixed desktop canvas.',
        suggestion: 'Replace hard-coded desktop width/min-width values and height:100vh overflow locks with fluid max-widths, wrapping grids, and responsive section heights.'
      })
    }
    if (hasMissingLayoutReset(normalized, styles)) {
      pushFinding(findings, {
        code: 'missing-layout-reset',
        severity: 'warning',
        message: 'The page uses visual media without a resilient layout reset.',
        suggestion: 'Add global box-sizing, fluid media rules, and min-width:0 constraints so images, embeds, and grid/flex children do not overflow responsive previews.'
      })
    }
    if (hasWeakTypographyConstraints(styles)) {
      pushFinding(findings, {
        code: 'weak-typography-constraints',
        severity: 'warning',
        message: 'The page uses typography constraints that can break across viewport sizes.',
        suggestion: 'Replace unbounded viewport-based font sizes with bounded type scales and keep letter spacing at 0 or positive values so headings remain readable.'
      })
    }
    if (hasWeakTypeHierarchy(normalized, styles)) {
      pushFinding(findings, {
        code: 'weak-type-hierarchy',
        severity: 'warning',
        message: 'The page title and body text have too little typographic hierarchy.',
        suggestion: 'Create a bounded type scale with a visibly larger or heavier H1/H2, readable body text, and clear metadata/caption sizing.'
      })
    }
    const hasMotion = /\b(animation|transition)\s*:/i.test(normalized) || /@keyframes\b/i.test(normalized)
    if (hasMotion && !/prefers-reduced-motion/i.test(normalized)) {
      pushFinding(findings, {
        code: 'missing-reduced-motion',
        severity: 'warning',
        message: 'The artifact uses motion but has no prefers-reduced-motion fallback.',
        suggestion: 'Add a reduced-motion media query that disables or simplifies animation and transition effects.'
      })
    }
    if (!/:(focus|focus-visible|focus-within)\b/i.test(normalized)) {
      pushFinding(findings, {
        code: 'missing-focus-states',
        severity: 'warning',
        message: 'No focus or focus-visible styling was found.',
        suggestion: 'Add clear keyboard focus states for links, buttons, inputs, and interactive controls.'
      })
    }
    if (hasInteractiveControls(normalized) && !hasInteractionStateAffordance(normalized)) {
      pushFinding(findings, {
        code: 'missing-interaction-states',
        severity: 'warning',
        message: 'Interactive controls lack hover, active, disabled, pressed, expanded, or selected state affordances.',
        suggestion: 'Add hover/active styles and at least one relevant state such as disabled, aria-pressed, aria-expanded, selected, or data-state feedback for controls.'
      })
    }
    if (!hasStaticPrimaryAction(normalized)) {
      pushFinding(findings, {
        code: 'missing-primary-action',
        severity: 'warning',
        message: 'No obvious interactive primary action was found.',
        suggestion: 'Add a clear primary action and any relevant secondary action for the page goal.'
      })
    }
    if (hasGenericActionCopy(normalized)) {
      pushFinding(findings, {
        code: 'generic-action-copy',
        severity: 'warning',
        message: 'The primary action labels are too generic to communicate the user task.',
        suggestion: 'Rewrite CTAs around the exact task, object, or outcome, such as "Approve invoice", "Compare plans", or "Retry sync".'
      })
    }
    if (weakDestructiveActionSafetyTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-destructive-action-safety',
        severity: 'warning',
        message: 'A destructive action lacks clear danger treatment, confirmation, or undo/recovery feedback.',
        suggestion: 'Style destructive actions with a danger tone and provide confirmation, undo toast, recovery copy, or an explicit irreversible-warning pattern.'
      })
    }
    if (weakDialogAffordanceTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-dialog-affordance',
        severity: 'warning',
        message: 'A dialog, modal, drawer, or popover lacks dialog semantics, an accessible title, or a close/cancel path.',
        suggestion: 'Add role="dialog" or native <dialog>, aria-modal/labeling, a visible heading, and Close/Cancel/Dismiss controls.'
      })
    }
    if (genericDialogTitleTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-dialog-title',
        severity: 'warning',
        message: 'A dialog, modal, drawer, or popover uses a generic title.',
        suggestion: 'Replace Details, Confirmation, or Warning-only dialog titles with titles that name the object, action, consequence, or workflow.'
      })
    }
    if (hasTopLevelHeading(normalized) && hasStaticPrimaryAction(normalized) && !hasFirstScreenSupportContent(normalized)) {
      pushFinding(findings, {
        code: 'weak-first-screen-hierarchy',
        severity: 'warning',
        message: 'The first screen has a page title and action but no supporting content near the goal.',
        suggestion: 'Add concise supporting copy, concrete data, or a small content module near the H1 so the page communicates value before secondary details.'
      })
    }
    if (!hasTopLevelHeading(normalized)) {
      pushFinding(findings, {
        code: 'missing-page-heading',
        severity: 'warning',
        message: 'No top-level H1 or aria-level=1 heading was found.',
        suggestion: 'Add a specific H1/page title that states the screen purpose before secondary sections or dense content.'
      })
    } else if (topLevelHeadingTexts(normalized).some(isGenericPageHeading)) {
      pushFinding(findings, {
        code: 'generic-page-heading',
        severity: 'warning',
        message: 'The top-level page heading is too generic to communicate the screen goal.',
        suggestion: 'Replace generic headings like "Dashboard" or "Overview" with a specific user outcome, workflow, or product area.'
      })
    }
    if (hasTopLevelHeading(normalized) && topLevelHeadingTexts(normalized).some(isMetaPageHeading)) {
      pushFinding(findings, {
        code: 'meta-page-heading',
        severity: 'warning',
        message: 'The top-level page heading reads like a prompt or page type instead of a real product title.',
        suggestion: 'Rewrite the H1 as the brand/product/person name or a literal offer/category, and move page-type context into supporting copy if needed.'
      })
    }
    if (genericSectionHeadingTags(normalized, visibleText).length >= 2) {
      pushFinding(findings, {
        code: 'generic-section-heading',
        severity: 'warning',
        message: 'Several marketing section headings are generic template labels.',
        suggestion: 'Replace bare headings like Features, Benefits, or Testimonials with product-specific headings that name the workflow, audience, proof, or outcome.'
      })
    }
    const deadLinks = deadAnchorTags(normalized)
    if (deadLinks.length > 0) {
      pushFinding(findings, {
        code: 'dead-link-targets',
        severity: 'warning',
        message: 'Some anchors use empty, "#", missing, or javascript-only href targets.',
        suggestion: 'Replace dead anchors with real prototype hrefs, valid section anchors, Back/Previous controls that call history.back(), or semantic buttons with local feedback.'
      })
    }
    if (
      hasInteractiveControls(normalized) &&
      !hasUsefulAnchorTarget(normalized) &&
      !hasScriptedInteraction(normalized) &&
      !/<form\b/i.test(normalized)
    ) {
      pushFinding(findings, {
        code: 'missing-interaction-behavior',
        severity: 'warning',
        message: 'The page has interactive-looking controls but no detectable link, form, or scripted behavior.',
        suggestion: 'Wire primary controls to a prototype link, form feedback, expanded panel, filter state, toast, or other visible interaction.'
      })
    }
    const unlabeledFields = unlabeledFieldTags(normalized)
    if (unlabeledFields.length > 0) {
      pushFinding(findings, {
        code: 'missing-form-labels',
        severity: 'warning',
        message: 'Some form fields have no associated label or accessible name.',
        suggestion: 'Add visible labels or aria-label/aria-labelledby for every input, select, and textarea; do not rely on placeholders alone.'
      })
    }
    if (weakFormAffordanceTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-form-affordance',
        severity: 'warning',
        message: 'A multi-field form lacks helper, required, optional, validation, or feedback affordances.',
        suggestion: 'Add required/optional markers, helper text, aria-describedby, error/success messages, or inline validation states so the form feels implementation-ready.'
      })
    }
}
