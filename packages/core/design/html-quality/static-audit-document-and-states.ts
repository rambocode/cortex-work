import type { DesignHtmlQualityAuditInput, DesignHtmlQualityFinding } from './types'
import type { DesignHtmlQualityStaticAuditContext } from './static-audit-types'
import { PLACEHOLDER_RE, decorativeVisualAnchorTags, documentTitleText, genericBreadcrumbLabelBlocks, genericFeedbackMessageCopyTags, genericPortfolioProjectDetailTags, genericProductNavigationBlocks, genericRecoverableStateCopyTags, hasStateLaundryList, hasStaticPrimaryAction, hasTopLevelHeading, hasWeakBrandIdentity, hasWeakBrandNavigation, hasWeakContentDepth, hasWeakDataRealism, hasWeakPortfolioStructure, hasWeakProductAppShell, hasWeakProductPreviewDetail, hasWeakSecondaryActionPath, hasWeakVisualAnchor, isGenericDocumentTitle, pushFinding, weakStateRecoveryActionTags } from './helper-index'

export function auditDocumentAndStateQuality(
  input: DesignHtmlQualityAuditInput,
  ctx: DesignHtmlQualityStaticAuditContext,
  findings: DesignHtmlQualityFinding[]
): void {
  const { normalized, styles, visibleText } = ctx
    if (!/<html[\s>]/i.test(normalized) || !/<\/html>\s*$/i.test(normalized.trim())) {
      pushFinding(findings, {
        code: 'incomplete-document',
        severity: 'critical',
        message: 'The artifact does not look like a complete standalone HTML document ending in </html>.',
        suggestion: 'Rewrite or finish the document so the saved file is complete, raw HTML.'
      })
    }
    const title = documentTitleText(normalized)
    if (!title) {
      pushFinding(findings, {
        code: 'missing-document-title',
        severity: 'warning',
        message: 'The HTML document has no meaningful <title>.',
        suggestion: 'Add a concise document title that names the product, brand, screen, or offer for browser tabs and handoff.'
      })
    } else if (isGenericDocumentTitle(title)) {
      pushFinding(findings, {
        code: 'generic-document-title',
        severity: 'warning',
        message: 'The HTML document title is generic or prompt-like.',
        suggestion: 'Replace the document title with a specific product, brand, screen, or offer name instead of Draft, Untitled, or page-type copy.'
      })
    }
    if (!/<meta[^>]+name=["']viewport["']/i.test(normalized)) {
      pushFinding(findings, {
        code: 'missing-viewport',
        severity: 'critical',
        message: 'The document is missing a viewport meta tag.',
        suggestion: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'
      })
    }
    if (PLACEHOLDER_RE.test(visibleText)) {
      pushFinding(findings, {
        code: 'placeholder-content',
        severity: 'warning',
        message: 'The visible copy still contains placeholder or generic sample content.',
        suggestion: 'Replace placeholders with plausible domain-specific data, labels, names, and microcopy.'
      })
    }
    if (hasTopLevelHeading(normalized) && hasStaticPrimaryAction(normalized) && hasWeakDataRealism(visibleText)) {
      pushFinding(findings, {
        code: 'weak-data-realism',
        severity: 'warning',
        message: 'The visible content lacks concrete domain data.',
        suggestion: 'Add realistic names, metrics, dates, prices, IDs, statuses, or records so the design reads as a real product screen.'
      })
    }
    if (hasStateLaundryList(visibleText)) {
      pushFinding(findings, {
        code: 'state-laundry-list',
        severity: 'warning',
        message: 'The visible copy lists state names instead of designing the states.',
        suggestion: 'Replace state-name lists with actual compact modules, banners, disabled controls, skeleton rows, empty illustrations, retry/error panels, or toast feedback.'
      })
    }
    if (weakStateRecoveryActionTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-state-recovery-action',
        severity: 'warning',
        message: 'A recoverable empty, error, offline, or permission state has no clear next action.',
        suggestion: 'Add a visible recovery action such as Retry, Clear filters, Import records, Connect source, Request access, or Contact support.'
      })
    }
    if (genericRecoverableStateCopyTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-recoverable-state-copy',
        severity: 'warning',
        message: 'A recoverable empty, error, offline, or permission state uses generic copy.',
        suggestion: 'Replace No data, Nothing here, or Something went wrong copy with the missing object, likely cause, domain-specific next step, and recovery action.'
      })
    }
    if (genericFeedbackMessageCopyTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-feedback-message-copy',
        severity: 'warning',
        message: 'A toast, alert, banner, or inline feedback message uses generic copy.',
        suggestion: 'Replace Success, Saved, Error, or Failed-only feedback with the object, action result, and next step or recovery path.'
      })
    }
    if (hasTopLevelHeading(normalized) && hasStaticPrimaryAction(normalized) && hasWeakContentDepth(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-content-depth',
        severity: 'warning',
        message: 'The page has too few meaningful content modules beyond the headline and primary action.',
        suggestion: 'Add at least two product-relevant modules such as a data table, record list, form, state panel, proof section, timeline, or settings group.'
      })
    }
    if (hasWeakProductAppShell(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-app-shell',
        severity: 'warning',
        message: 'This app-like screen has product modules but no visible product shell, navigation, or workspace chrome.',
        suggestion: 'Add product chrome such as a top bar, sidebar, nav rail, breadcrumbs, search, user/status area, or workspace switcher around the work surface.'
      })
    }
    if (genericProductNavigationBlocks(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-product-navigation',
        severity: 'warning',
        message: 'The product navigation uses generic dashboard template labels.',
        suggestion: 'Replace Dashboard, Analytics, Reports, or Settings-only navigation with domain-specific product areas, objects, queues, workflows, or saved views.'
      })
    }
    if (genericBreadcrumbLabelBlocks(normalized, visibleText, (input.siblingScreens?.length ?? 0) > 0).length > 0) {
      pushFinding(findings, {
        code: 'generic-breadcrumb-labels',
        severity: 'warning',
        message: 'A breadcrumb or page path uses generic template labels.',
        suggestion: 'Replace Home, Dashboard, Details, or Page 1-only trails with product areas, objects, record names, IDs, or workflow stages.'
      })
    }
    if (hasWeakBrandNavigation(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-brand-navigation',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has no branded header or section navigation.',
        suggestion: 'Add a branded header/nav with logo or wordmark, links to key sections, and a visible primary action.'
      })
    }
    if (hasWeakBrandIdentity(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-brand-identity',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has navigation but no visible brand or product identity.',
        suggestion: 'Add a visible wordmark, logo, product name, or named creator/place in the header or first viewport so the page feels specific.'
      })
    }
    if (hasWeakSecondaryActionPath(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-secondary-action-path',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing first screen has no clear secondary action path.',
        suggestion: 'Pair the primary CTA with a distinct secondary action such as View demo, See features, Read case study, Compare plans, or Contact sales.'
      })
    }
    if (hasWeakPortfolioStructure(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-portfolio-structure',
        severity: 'warning',
        message: 'This portfolio or case-study page lacks concrete project entries and outcome details.',
        suggestion: 'Add real project/case-study cards with client, role/category, timeline or year, visual, outcome metric, and detail CTAs.'
      })
    }
    if (genericPortfolioProjectDetailTags(normalized, visibleText).length >= 2) {
      pushFinding(findings, {
        code: 'generic-portfolio-project-detail',
        severity: 'warning',
        message: 'Several portfolio or case-study entries use placeholder project or client labels.',
        suggestion: 'Replace Project One, Client A, or Case Study placeholders with realistic project names, client names, roles, timelines, visuals, and outcome metrics.'
      })
    }
    if (hasWeakVisualAnchor(normalized, styles, visibleText)) {
      pushFinding(findings, {
        code: 'weak-visual-anchor',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has no strong visual anchor.',
        suggestion: 'Add a real product preview, screenshot, image, gallery, media-led hero, or clearly designed mockup that shows the product or offer.'
      })
    }
    if (hasWeakProductPreviewDetail(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-product-preview-detail',
        severity: 'warning',
        message: 'A product preview, mockup, or media panel is only an empty framed shell.',
        suggestion: 'Fill previews with real media or concrete UI/data details such as dashboard rows, metrics, statuses, screenshots, or labeled controls.'
      })
    }
    if (decorativeVisualAnchorTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'decorative-visual-anchor',
        severity: 'warning',
        message: 'A primary visual anchor is only abstract decoration.',
        suggestion: 'Replace abstract blobs, orbs, gradients, or decorative SVG shapes with a product screenshot, media asset, gallery image, or concrete UI mockup with real labels and data.'
      })
    }
}
