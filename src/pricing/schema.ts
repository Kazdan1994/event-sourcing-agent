import { z } from "zod";
import {
  Limit,
  Price as S8Price,
} from "./base-schema.ts";

// "annual" = the per-period amount when billed yearly ("$20/month billed annually")
export const Billing = z.enum(["annual", "monthly"]);

export const Price = S8Price.extend({ billing: Billing });

export const Plan = z
  .object({
    name: z.string().min(1),
    prices: z.array(Price).max(2), // One per billing option shown, empty on quote
    isFree: z.boolean(),
    limits: z.array(Limit).max(10),
  })
  .refine(
    (plan) => !plan.isFree || plan.prices.every((price) => price.amount === 0),
    { message: "a free plan must have no price or an amount of 0", path: ["prices"] },
  )
  .refine(
    (plan) => new Set(plan.prices.map((price) => price.billing)).size === plan.prices.length,
    { message: "one price per billing option", path: ["prices"] },
  );

export const PricingGrid = z.object({
  product: z.string().min(1),
  plans: z.array(Plan).min(1),
});

export type Billing = z.infer<typeof Billing>;
export type Price = z.infer<typeof Price>;
export type Plan = z.infer<typeof Plan>;
export type PricingGrid = z.infer<typeof PricingGrid>;
