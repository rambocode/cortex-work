import type { DesignHtmlQualityAuditInput, DesignHtmlQualityFinding } from './types'
import type { DesignHtmlQualityStaticAuditContext } from './static-audit-types'
import { VAGUE_TEMPLATE_COPY_PATTERNS, countPatternHits, duplicatedDesignCardCopyTexts, genericConversionCloseTags, genericFaqAnswerTags, genericFaqQuestionTags, genericFeatureCardDetailTags, genericPricingPlanActionLabelTags, genericPricingPlanDetailTags, genericSiteFooterDetailTags, genericTestimonialCopyTags, genericTrustProofTags, genericVanityMetricTags, hasCenterEverythingLayout, hasGenericPurpleBlueGradient, hasWeakConversionClose, hasWeakFaqAnatomy, hasWeakFeatureAnatomy, hasWeakHeroViewportComposition, hasWeakPricingStructure, hasWeakSiteFooter, hasWeakTestimonialAttribution, hasWeakTrustProof, pushFinding } from './helper-index'

export function auditProductAndMarketingQuality(
  _input: DesignHtmlQualityAuditInput,
  ctx: DesignHtmlQualityStaticAuditContext,
  findings: DesignHtmlQualityFinding[]
): void {
  const { normalized, styles, visibleText } = ctx
    if (hasWeakHeroViewportComposition(normalized, styles, visibleText)) {
      pushFinding(findings, {
        code: 'weak-hero-viewport-composition',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page uses a full-height hero that hides the next section.',
        suggestion: 'Reduce hero min-height, adjust spacing, or add a visible next-section peek so the first viewport hints at more content below.'
      })
    }
    if (hasWeakTrustProof(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-trust-proof',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has no concrete trust proof.',
        suggestion: 'Add customer logos, testimonials, ratings, case-study metrics, press mentions, or security/compliance badges with realistic names and numbers.'
      })
    }
    if (genericTrustProofTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-trust-proof',
        severity: 'warning',
        message: 'A trust proof, logo, customer, or press module uses generic placeholder labels.',
        suggestion: 'Replace generic proof labels such as Logo 1, Company A, or Client B with realistic customer names, publication names, certification badges, ratings, or outcome metrics.'
      })
    }
    if (genericVanityMetricTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-vanity-metrics',
        severity: 'warning',
        message: 'A proof, impact, or metrics module uses generic vanity statistics.',
        suggestion: 'Replace broad stats like 99% satisfaction, 10x faster, 1M+ users, or 24/7 support with sourced customer metrics, timeframes, benchmarks, or case-study outcomes.'
      })
    }
    if (hasWeakTestimonialAttribution(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-testimonial-attribution',
        severity: 'warning',
        message: 'A testimonial or customer quote lacks credible attribution.',
        suggestion: 'Add a named person or company, role/source, and concrete outcome context to each testimonial or customer quote.'
      })
    }
    if (genericTestimonialCopyTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-testimonial-copy',
        severity: 'warning',
        message: 'A testimonial or customer quote uses generic praise without concrete outcome context.',
        suggestion: 'Replace vague praise such as Amazing product or Highly recommend with a workflow, metric, timeframe, or case-study result.'
      })
    }
    if (hasWeakFeatureAnatomy(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-feature-anatomy',
        severity: 'warning',
        message: 'This landing, brand, product, feature, or marketing page has no concrete feature or benefit anatomy.',
        suggestion: 'Add feature, benefit, capability, or use-case sections with named product capabilities, user outcomes, and product-specific details.'
      })
    }
    if (genericFeatureCardDetailTags(normalized, visibleText).length >= 2) {
      pushFinding(findings, {
        code: 'generic-feature-card-detail',
        severity: 'warning',
        message: 'Several feature or benefit cards use generic capability copy.',
        suggestion: 'Replace broad cards such as Automation, Analytics, or Security with named product capabilities tied to concrete objects, workflows, user outcomes, or measurable details.'
      })
    }
    if (hasWeakPricingStructure(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-pricing-structure',
        severity: 'warning',
        message: 'This pricing or plans page lacks a complete pricing comparison structure.',
        suggestion: 'Add distinct plan cards or a comparison table with prices, billing cadence, a recommended plan, feature differences, and plan-specific CTAs.'
      })
    }
    if (genericPricingPlanDetailTags(normalized, visibleText).length >= 2) {
      pushFinding(findings, {
        code: 'generic-pricing-plan-detail',
        severity: 'warning',
        message: 'Several pricing plan cards use generic filler instead of concrete plan differences.',
        suggestion: 'Replace filler such as All core features, Everything you need, or Priority support with concrete limits, plan-specific capabilities, audiences, service levels, or upgrade reasons.'
      })
    }
    if (genericPricingPlanActionLabelTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-pricing-plan-action-labels',
        severity: 'warning',
        message: 'Several pricing plan cards repeat the same generic action label.',
        suggestion: 'Replace repeated Choose plan, Get started, or Start trial actions with plan-specific CTAs such as Start studio trial, Upgrade to agency launch, or Talk to enterprise sales.'
      })
    }
    if (duplicatedDesignCardCopyTexts(normalized).length > 0) {
      pushFinding(findings, {
        code: 'duplicated-card-copy',
        severity: 'warning',
        message: 'Repeated feature, pricing, proof, project, or testimonial cards reuse the same copy.',
        suggestion: 'Give each repeated card a distinct title, concrete detail, data point, outcome, or audience-specific reason to exist.'
      })
    }
    if (hasWeakConversionClose(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-conversion-close',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has no final conversion or next-step section near the end.',
        suggestion: 'Add a closing CTA/footer, FAQ, contact/demo/signup form, calendar/contact route, or next-step section so the page has a complete conversion path.'
      })
    }
    if (genericConversionCloseTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-conversion-close',
        severity: 'warning',
        message: 'The final conversion or next-step section uses generic closing copy.',
        suggestion: 'Replace vague closes such as Ready to get started with a specific outcome, timeframe, next deliverable, or domain-specific CTA.'
      })
    }
    if (hasWeakFaqAnatomy(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-faq-anatomy',
        severity: 'warning',
        message: 'An FAQ or frequently asked questions section is too thin to handle real customer objections.',
        suggestion: 'Add multiple concrete question/answer items covering objections such as pricing, migration, support, security, setup, or timeline.'
      })
    }
    if (genericFaqQuestionTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-faq-questions',
        severity: 'warning',
        message: 'An FAQ or frequently asked questions section uses generic template questions.',
        suggestion: 'Replace questions such as What is this, How does it work, or Who is this for with concrete objections about pricing, migration, setup time, security, support, integrations, or plan limits.'
      })
    }
    if (genericFaqAnswerTags(normalized).length > 0) {
      pushFinding(findings, {
        code: 'generic-faq-answers',
        severity: 'warning',
        message: 'An FAQ or frequently asked questions section uses generic, evasive answers.',
        suggestion: 'Replace vague answers such as Contact us, Learn more, or Our team can help with concrete objection-handling details about pricing, migration, security, support, setup, timelines, or integrations.'
      })
    }
    if (hasWeakSiteFooter(normalized, visibleText)) {
      pushFinding(findings, {
        code: 'weak-site-footer',
        severity: 'warning',
        message: 'This brand, landing, portfolio, pricing, or marketing page has no complete site footer.',
        suggestion: 'Add a real footer with brand/contact details, secondary links, social/legal links, copyright, support, newsletter, or status information.'
      })
    }
    if (genericSiteFooterDetailTags(normalized, visibleText).length > 0) {
      pushFinding(findings, {
        code: 'generic-site-footer-detail',
        severity: 'warning',
        message: 'The site footer uses generic template columns without concrete footer details.',
        suggestion: 'Replace Product, Company, or Resources-only footer columns with brand/contact details, legal/status/social/help links, copyright, or product-specific routes.'
      })
    }
    if (countPatternHits(visibleText, VAGUE_TEMPLATE_COPY_PATTERNS) >= 2) {
      pushFinding(findings, {
        code: 'vague-template-copy',
        severity: 'warning',
        message: 'The visible copy leans on generic template/marketing phrases instead of product-specific content.',
        suggestion: 'Replace vague claims with concrete user tasks, domain nouns, real data points, names, prices, dates, or outcome-specific microcopy.'
      })
    }
    if (hasGenericPurpleBlueGradient(normalized)) {
      pushFinding(findings, {
        code: 'generic-ai-gradient',
        severity: 'warning',
        message: 'The page appears to use a generic purple/blue AI-style gradient.',
        suggestion: 'Replace it with a product-specific palette, neutral ramp, and purposeful accent color.'
      })
    }
    if (hasCenterEverythingLayout(styles)) {
      pushFinding(findings, {
        code: 'center-everything-layout',
        severity: 'warning',
        message: 'The page appears to center every major block in a template-like layout.',
        suggestion: 'Introduce real information architecture with aligned sections, split content, grids, tables, or lists instead of centering every block.'
      })
    }
}
