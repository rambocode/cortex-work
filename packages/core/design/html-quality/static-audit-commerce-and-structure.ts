import type { DesignHtmlQualityAuditInput, DesignHtmlQualityFinding } from './types'
import type { DesignHtmlQualityStaticAuditContext } from './static-audit-types'
import { CREAM_BACKGROUND_RE, countEmoji, genericChartLabelTags, genericMetricCardLabelTags, genericRecordActionLabelTags, genericRecordDiscoveryControlTags, genericRecordItemLabelTags, genericRecordTableColumnTags, hasOneNotePalette, hasOverRoundedCardStyling, hasWeakColorSystem, hasWeakSpacingSystem, nestedCardLikeTags, pseudoListContainerTags, pushFinding, unnamedContentSectionTags, weakChartStructureTags, weakMetricContextTags, weakRecordActionTags, weakRecordDiscoveryControlTags, weakStatusAffordanceTags, weakTableStructureTags } from './helper-index'

export function auditCommerceAndStructureQuality(
  _input: DesignHtmlQualityAuditInput,
  ctx: DesignHtmlQualityStaticAuditContext,
  findings: DesignHtmlQualityFinding[]
): void {
  const { normalized, styles, visibleText } = ctx
    if (CREAM_BACKGROUND_RE.test(styles)) {
      pushFinding(findings, {
        code: 'default-cream-background',
        severity: 'warning',
        message: 'The page uses a default cream/beige/sand background pattern.',
        suggestion: 'Choose a surface color that fits the product identity instead of the common AI default warm canvas.'
      })
    }
    if (hasWeakColorSystem(styles)) {
      pushFinding(findings, {
        code: 'weak-color-system',
        severity: 'warning',
        message: 'The page uses many hard-coded colors without reusable palette tokens.',
        suggestion: 'Define reusable CSS custom properties for neutral, surface, text, border, and accent roles, then use those tokens consistently across modules.'
      })
    }
    if (hasOneNotePalette(styles)) {
      pushFinding(findings, {
        code: 'one-note-palette',
        severity: 'warning',
        message: 'The palette is dominated by variations of a single hue family.',
        suggestion: 'Keep the brand color intentional, but add neutral surfaces plus at least one distinct supporting accent or semantic color so the page has richer hierarchy.'
      })
    }
    if (hasWeakSpacingSystem(styles)) {
      pushFinding(findings, {
        code: 'weak-spacing-system',
        severity: 'warning',
        message: 'The page repeats the same default spacing value across most layout rules.',
        suggestion: 'Create a small spacing scale with reusable tokens and vary section, group, and control spacing so the layout has real rhythm instead of 16px everywhere.'
      })
    }
    if (hasOverRoundedCardStyling(styles)) {
      pushFinding(findings, {
        code: 'over-rounded-card-styling',
        severity: 'warning',
        message: 'Card or panel containers use oversized rounded corners.',
        suggestion: 'Use a restrained radius scale for product surfaces, usually around 6-8px for cards and panels, reserving larger radii for intentionally pill-shaped controls or media.'
      })
    }
    if (nestedCardLikeTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'nested-card-layout',
        severity: 'warning',
        message: 'The page appears to put card-like containers inside other cards.',
        suggestion: 'Flatten nested cards into clear sections, grids, rows, or tables; keep cards as sibling repeated items instead of card-in-card shells.'
      })
    }
    const weakTables = weakTableStructureTags(normalized)
    if (weakTables.length > 0) {
      pushFinding(findings, {
        code: 'weak-table-structure',
        severity: 'warning',
        message: 'Some data tables have no headers or accessible table context.',
        suggestion: 'Add table headers, scope attributes, captions, or aria labels so data modules are readable and implementation-ready.'
      })
    }
    if (weakRecordActionTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-record-actions',
        severity: 'warning',
        message: 'A record table or list shows actionable business items without row, bulk, or detail actions.',
        suggestion: 'Add clear record affordances such as row actions, checkboxes with bulk actions, detail links, approve/retry/assign buttons, or contextual menus.'
      })
    }
    if (genericRecordItemLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-record-item-labels',
        severity: 'warning',
        message: 'A record list or card group uses generic item titles.',
        suggestion: 'Replace Item 1, Task 2, Record A, or Customer B-only item titles with concrete customers, invoices, tickets, renewals, owners, dates, amounts, or workflow context.'
      })
    }
    if (genericRecordActionLabelTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-record-action-labels',
        severity: 'warning',
        message: 'A record table or list uses generic row action labels.',
        suggestion: 'Replace View, Details, More, or Open-only record actions with task-specific labels such as Review renewal, Assign owner, Retry sync, Approve invoice, or Resolve ticket.'
      })
    }
    if (genericRecordTableColumnTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-record-table-columns',
        severity: 'warning',
        message: 'A record table uses generic template column labels.',
        suggestion: 'Replace Name, Status, Date, or Action-only columns with domain-specific fields such as account, invoice, renewal, amount, due date, risk, owner, SLA, or workflow stage.'
      })
    }
    if (weakRecordDiscoveryControlTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-record-discovery-controls',
        severity: 'warning',
        message: 'A dense record table or list has no search, filter, sort, pagination, or view controls.',
        suggestion: 'Add record discovery controls such as search, status/date filters, sortable columns, pagination, saved views, or segmented tabs.'
      })
    }
    if (genericRecordDiscoveryControlTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-record-discovery-controls',
        severity: 'warning',
        message: 'A dense record table or list uses generic search, filter, or view controls.',
        suggestion: 'Replace Search, Filter, or All statuses-only controls with object-specific search labels, domain filters, saved views, sort labels, or pagination copy.'
      })
    }
    if (weakMetricContextTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-metric-context',
        severity: 'warning',
        message: 'Several KPI or metric cards show values without timeframe, delta, target, or trend context.',
        suggestion: 'Add comparison context such as timeframe, previous-period delta, target/goal, trend direction, or benchmark notes for each key metric.'
      })
    }
    if (genericMetricCardLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-metric-card-labels',
        severity: 'warning',
        message: 'Several KPI or metric cards use generic dashboard labels.',
        suggestion: 'Replace Revenue, Users, Growth, or Tasks-only scorecards with metrics that name the business object, workflow, period, owner, SLA, risk, or target.'
      })
    }
    if (weakChartStructureTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-chart-structure',
        severity: 'warning',
        message: 'A chart-like visualization has bars/marks but no clear data labels, caption, legend, or accessible chart context.',
        suggestion: 'Add a chart title or caption, axis or legend labels, visible values, and accessible SVG title/desc or aria labels tied to concrete data.'
      })
    }
    if (genericChartLabelTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-chart-labels',
        severity: 'warning',
        message: 'A chart-like visualization uses generic chart labels.',
        suggestion: 'Replace Chart, Data, Growth, or Series 1-only labels with the business metric, object, period, comparison, or segment shown.'
      })
    }
    if (pseudoListContainerTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-list-structure',
        severity: 'warning',
        message: 'A repeated record/list module is built from generic containers without list, table, or row semantics.',
        suggestion: 'Use ul/li, ol/li, table rows, role=list/listitem, or role=row semantics for queues, timelines, feeds, and repeated record groups.'
      })
    }
    if (weakStatusAffordanceTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'weak-status-affordance',
        severity: 'warning',
        message: 'Repeated status values render as plain text instead of semantic visual states.',
        suggestion: 'Render statuses as labeled badges, chips, or state tags with semantic tone, accessible labels, and clear contrast.'
      })
    }
    if (unnamedContentSectionTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'unnamed-content-section',
        severity: 'warning',
        message: 'A meaningful content module has no visible heading or accessible section name.',
        suggestion: 'Add concise section headings, legends, aria-label, or aria-labelledby for major panels, lists, forms, asides, and status modules.'
      })
    }
    if (countEmoji(visibleText) >= 3) {
      pushFinding(findings, {
        code: 'emoji-iconography',
        severity: 'warning',
        message: 'The visible design uses several emoji, likely as icon placeholders.',
        suggestion: 'Replace emoji icons with text labels, CSS-drawn marks, inline SVG, or a consistent icon system.'
      })
    }
    if (!/@media\b/i.test(normalized) && !/\bclamp\(/i.test(normalized)) {
      pushFinding(findings, {
        code: 'weak-responsive-rules',
        severity: 'warning',
        message: 'No media query or clamp() responsive sizing was found.',
        suggestion: 'Add explicit mobile/tablet/desktop behavior so the design does not collapse at different canvas sizes.'
      })
    }
}
