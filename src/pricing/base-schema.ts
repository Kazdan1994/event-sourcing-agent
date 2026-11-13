import { z } from "zod";

export const Currency = z.enum(["EUR", "USD", "GBP"]);

export const Price = z.object({
  amount: z.number().nonnegative(),
  currency: Currency,
  period: z.enum(["month", "year"]),
  unit: z.enum(["user", "workspace", "flat"]),
});

export const Limit = z.object({ label: z.string(), value: z.string() });

export const Plan = z
  .object({
    name: z.string().min(1),
    price: Price.nullable(), // null on quote, or no price visible on the page
    isFree: z.boolean(),
    limits: z.array(Limit).max(5), // Capped: the model otherwise copies the whole feature table
  })
  .refine(
    (plan) => !plan.isFree || plan.price === null || plan.price.amount === 0,
    {
      message: "a free plan must have no price or an amount of 0",
      path: ["price"],
    },
  );

// One price per plan: the one for the billing period displayed by default
export const PricingGrid = z.object({
  product: z.string().min(1),
  plans: z.array(Plan).min(1),
});

export type Price = z.infer<typeof Price>;
export type Plan = z.infer<typeof Plan>;
export type PricingGrid = z.infer<typeof PricingGrid>;
