import type { DesignHtmlQualityAuditInput, DesignHtmlQualityFinding } from './types'
import type { DesignHtmlQualityStaticAuditContext } from './static-audit-types'
import { genericFormFieldLabelTags, genericImageAltTags, genericSettingsControlLabelTags, genericTabLabelTags, genericWorkflowStepLabelTags, hasAny, hasMultiItemPrototypeNavigationWithoutCurrentState, hasNavigationLandmark, hasSiblingPrototypeNavigation, inertFormTags, linkedSiblingPrototypeTargetCount, missingImageAltTags, missingImageSourceTags, pushFinding, unnamedIconOnlyControlTags, weakLeadFormResponseTags, weakTabCurrentStateTags, weakWorkflowStepStateTags } from './helper-index'

export function auditAccessibilityAndPrototypeQuality(
  input: DesignHtmlQualityAuditInput,
  ctx: DesignHtmlQualityStaticAuditContext,
  findings: DesignHtmlQualityFinding[]
): void {
  const { normalized, lower, visibleText } = ctx
    if (weakLeadFormResponseTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'weak-lead-form-response',
        severity: 'warning',
        message: 'A marketing lead form lacks visible loading, success, and error feedback states.',
        suggestion: 'Add submitting/loading, success/confirmation, and error/validation feedback states for contact, demo, signup, waitlist, or newsletter forms.'
      })
    }
    if (genericFormFieldLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-form-field-labels',
        severity: 'warning',
        message: 'A lead or product form uses generic field labels.',
        suggestion: 'Replace Name, Email, Message, or Details-only fields with labels tied to the requested business information, use case, timeline, budget, volume, or workflow.'
      })
    }
    if (genericSettingsControlLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-settings-control-labels',
        severity: 'warning',
        message: 'A settings, permissions, or preferences control group uses generic labels.',
        suggestion: 'Replace Option 1, Enable, Notifications, or Setting-only toggles with labels that name the controlled object, effect, audience, or workflow.'
      })
    }
    const unnamedIconControls = unnamedIconOnlyControlTags(normalized)
    if (unnamedIconControls.length > 0) {
      pushFinding(findings, {
        code: 'unnamed-icon-controls',
        severity: 'warning',
        message: 'Some icon-only buttons or links have no accessible name.',
        suggestion: 'Add visible text, screen-reader-only text, aria-label, aria-labelledby, or title for every icon-only control.'
      })
    }
    const missingImageSources = missingImageSourceTags(normalized)
    if (missingImageSources.length > 0) {
      pushFinding(findings, {
        code: 'missing-image-source',
        severity: 'warning',
        message: 'Some image elements have empty, "#", or javascript-only sources.',
        suggestion: 'Use real workspace-relative image paths, embedded data URLs, or replace missing images with designed CSS/SVG placeholders that carry meaningful labels.'
      })
    }
    const missingImageAlts = missingImageAltTags(normalized)
    if (missingImageAlts.length > 0) {
      pushFinding(findings, {
        code: 'missing-image-alt',
        severity: 'warning',
        message: 'Some non-decorative images have no accessible description.',
        suggestion: 'Add meaningful alt text or mark purely decorative images with alt="", aria-hidden="true", or role="presentation".'
      })
    }
    const genericImageAlts = genericImageAltTags(normalized)
    if (genericImageAlts.length > 0) {
      pushFinding(findings, {
        code: 'generic-image-alt',
        severity: 'warning',
        message: 'Some image descriptions are generic and do not describe the actual content.',
        suggestion: 'Replace generic alt text such as Image, Screenshot, or Product preview with the product, person, place, screen, or content shown.'
      })
    }
    const inertForms = inertFormTags(normalized)
    if (inertForms.length > 0) {
      pushFinding(findings, {
        code: 'inert-form-submission',
        severity: 'warning',
        message: 'Some forms have no detectable submit destination or local feedback.',
        suggestion: 'Add a real action/formaction, data-prototype-target/data-href, onsubmit handler, or scripted prototype feedback such as validation, loading, success, error, or toast states.'
      })
    }
    if (!hasSiblingPrototypeNavigation(normalized, input.siblingScreens)) {
      pushFinding(findings, {
        code: 'missing-prototype-navigation',
        severity: 'warning',
        message: 'This multi-screen project page does not link to any sibling screen.',
        suggestion: 'Add clickable prototype routes for relevant nav items, tabs, cards, or CTAs using `<a href>`, `data-href`, `data-prototype-href`, or `data-prototype-target` with the provided hrefs or exact screen titles; use history.back() only for Back/Previous controls.'
      })
    }
    if ((input.siblingScreens?.length ?? 0) >= 2 && linkedSiblingPrototypeTargetCount(normalized, input.siblingScreens) < 2) {
      pushFinding(findings, {
        code: 'weak-prototype-navigation-coverage',
        severity: 'warning',
        message: 'This multi-screen project page links to only one sibling screen.',
        suggestion: 'Add prototype links to multiple relevant sibling pages in the nav, tabs, breadcrumbs, cards, or primary/secondary actions using `<a href>`, `data-href`, `data-prototype-href`, or `data-prototype-target` so the project can be browsed as a connected prototype.'
      })
    }
    if ((input.siblingScreens?.length ?? 0) > 0 && !hasNavigationLandmark(normalized)) {
      pushFinding(findings, {
        code: 'missing-navigation-landmark',
        severity: 'warning',
        message: 'This multi-screen project page has no navigation landmark.',
        suggestion: 'Add a consistent nav, tabs, breadcrumb, or page switcher with real prototype routes to related screens.'
      })
    }
    if ((input.siblingScreens?.length ?? 0) > 0 && hasMultiItemPrototypeNavigationWithoutCurrentState(normalized)) {
      pushFinding(findings, {
        code: 'missing-navigation-current-state',
        severity: 'warning',
        message: 'This multi-screen navigation has no visible or accessible current-page state.',
        suggestion: 'Mark the current page, tab, or breadcrumb with aria-current, aria-selected, data-state="active", or a visible active/current style.'
      })
    }
    if (weakTabCurrentStateTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-tab-current-state',
        severity: 'warning',
        message: 'A tab, segmented control, or view switcher has no visible or accessible selected state.',
        suggestion: 'Mark the active tab with aria-selected, aria-current, data-state="active", or a visible active/current/selected style.'
      })
    }
    if (genericTabLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-tab-labels',
        severity: 'warning',
        message: 'A tab, segmented control, or view switcher uses generic tab labels.',
        suggestion: 'Replace Overview, Details, Settings, or Tab 1 labels with domain-specific views, queues, objects, or workflow stages.'
      })
    }
    if (weakWorkflowStepStateTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-workflow-step-state',
        severity: 'warning',
        message: 'A multi-step workflow, stepper, timeline, or process has no current, completed, or upcoming step state.',
        suggestion: 'Mark workflow steps with current/completed/upcoming state using aria-current, data-state/status, progressbar values, or visible active/completed/pending styling.'
      })
    }
    if (genericWorkflowStepLabelTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-workflow-step-labels',
        severity: 'warning',
        message: 'A multi-step workflow, stepper, timeline, or process uses generic step labels.',
        suggestion: 'Replace Step 1, Step 2, or Phase 3 labels with domain-specific actions, milestones, objects, or decisions in the flow.'
      })
    }
    if (!hasAny(lower, [/\bempty\b/, /\bloading\b/, /\berror\b/, /\bdisabled\b/, /\bskeleton\b/, /\boffline\b/, /aria-busy/])) {
      pushFinding(findings, {
        code: 'missing-ui-states',
        severity: 'info',
        message: 'The artifact does not mention common product states such as empty, loading, error, disabled, or offline.',
        suggestion: 'Represent the states that matter for this screen, visually or as compact inline modules.'
      })
    }
    if (!/<(main|header|nav|section|article|footer)\b/i.test(normalized)) {
      pushFinding(findings, {
        code: 'weak-semantic-structure',
        severity: 'info',
        message: 'The document lacks common semantic layout elements.',
        suggestion: 'Use semantic regions such as header, nav, main, section, article, and footer.'
      })
    }
    const notes = (input.designNotes ?? '').trim()
    if (notes) {
      const notesLower = notes.toLowerCase()
      if (!hasAny(notesLower, [/\bstate/, /\bempty\b/, /\bloading\b/, /\berror\b/, /\bdisabled\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-states',
          severity: 'info',
          message: 'DESIGN.md does not describe key UI states.',
          suggestion: 'Update DESIGN.md with the page states and how they should be implemented.'
        })
      }
      if (!hasAny(notesLower, [/\b(?:page|screen|view|surface)\s+role\b/, /\bpurpose\b/, /\bgoal\b/, /\baudience\b/, /\bprimary action\b/, /\buser intent\b/, /\bworkflow\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-page-role',
          severity: 'info',
          message: 'DESIGN.md does not describe the page role or user goal.',
          suggestion: 'Update DESIGN.md with the page/screen role, target user, primary goal, and primary action.'
        })
      }
      if (!hasAny(notesLower, [/\bresponsive\b/, /\bmobile\b/, /\btablet\b/, /\bdesktop\b/, /\bbreakpoint\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-responsive',
          severity: 'info',
          message: 'DESIGN.md does not describe responsive behavior.',
          suggestion: 'Update DESIGN.md with the intended mobile, tablet, and desktop behavior.'
        })
      }
      if (!hasAny(notesLower, [/\binteraction/, /\bprototype\b/, /\bnavigation\b/, /\bcta\b/, /\blink\b/, /\bhover\b/, /\bfocus\b/, /\bexpand\b/, /\bfilter\b/, /\bsubmit\b/, /\btoast\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-interactions',
          severity: 'info',
          message: 'DESIGN.md does not describe key interactions or prototype behavior.',
          suggestion: 'Update DESIGN.md with primary/secondary actions, navigation links, local feedback, and any hover/focus/disabled behavior.'
        })
      }
      if (!hasAny(notesLower, [/\btoken/, /\bcomponent/, /\bpalette\b/, /\bcolor\b/, /\btypography\b/, /\bspacing\b/, /\bradius\b/, /\bshadow\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-tokens',
          severity: 'info',
          message: 'DESIGN.md does not mention the tokens or components used.',
          suggestion: 'Update DESIGN.md with the palette, typography, spacing/radius decisions, and reusable components that implementation should preserve.'
        })
      }
      if (!hasAny(notesLower, [/\bimplementation\b/, /\bhandoff\b/, /\bbuild\b/, /\bdeveloper\b/, /\bengineering\b/, /\bassets?\b/, /\bdata\b/, /\bcontent\b/, /\bbehavior\b/, /\bcomponent contract\b/])) {
        pushFinding(findings, {
          code: 'notes-missing-implementation-notes',
          severity: 'info',
          message: 'DESIGN.md does not include implementation or handoff notes.',
          suggestion: 'Update DESIGN.md with implementation notes such as component structure, assets, data assumptions, and behavior details.'
        })
      }
    }
}
