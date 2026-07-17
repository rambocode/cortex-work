import { z } from "zod";

export const SLIDES_CHART_LIMITS = {
  categories: 50,
  series: 12,
  labelChars: 120,
  absoluteValue: 1_000_000_000_000,
} as const;

const chartColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((value) => value.replace(/^#/, "").toUpperCase());

const chartSeriesSchema = z
  .object({
    name: z.string().trim().min(1).max(SLIDES_CHART_LIMITS.labelChars),
    values: z
      .array(z.number().finite().min(-SLIDES_CHART_LIMITS.absoluteValue).max(SLIDES_CHART_LIMITS.absoluteValue))
      .min(1)
      .max(SLIDES_CHART_LIMITS.categories),
    color: chartColorSchema.optional(),
  })
  .strict();

export const slidesChartSpecSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(["bar", "line", "pie"]),
    categories: z
      .array(z.string().trim().min(1).max(SLIDES_CHART_LIMITS.labelChars))
      .min(1)
      .max(SLIDES_CHART_LIMITS.categories),
    series: z.array(chartSeriesSchema).min(1).max(SLIDES_CHART_LIMITS.series),
    legend: z.boolean().optional(),
    dataLabels: z.boolean().optional(),
    xAxisTitle: z.string().trim().max(SLIDES_CHART_LIMITS.labelChars).optional(),
    yAxisTitle: z.string().trim().max(SLIDES_CHART_LIMITS.labelChars).optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    for (const [index, series] of spec.series.entries()) {
      if (series.values.length !== spec.categories.length) {
        context.addIssue({
          code: "custom",
          path: ["series", index, "values"],
          message: "series values 数量必须与 categories 一致",
        });
      }
    }
    if (spec.type === "pie" && spec.series.length !== 1) {
      context.addIssue({ code: "custom", path: ["series"], message: "pie 图表只允许一个 series" });
    }
  });

export type SlidesChartSpec = z.infer<typeof slidesChartSpecSchema>;

export type SlidesChartSpecParseResult =
  | { ok: true; value: SlidesChartSpec }
  | { ok: false; code: "chart-spec-invalid"; message: string };

export function parseSlidesChartSpec(input: unknown): SlidesChartSpecParseResult {
  const parsed = slidesChartSpecSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    code: "chart-spec-invalid",
    message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; "),
  };
}
