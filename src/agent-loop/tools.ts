import { z } from "zod";
import { Billing } from "../pricing/schema.ts";
import type { Catalog } from "./catalog.ts";

export type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: "invalid_args" | "not_found"; message: string };

export type ToolDefinition<A = any> = {
  name: string;
  description: string;
  args: z.ZodType<A>;
  handler: (args: A, catalog: Catalog) => ToolOutcome;
};

const notFound = (message: string): ToolOutcome => ({
  ok: false,
  kind: "not_found",
  message,
});

const closestIds = (catalog: Catalog, query: string) =>
  [...catalog.keys()]
    .filter(
      (id) => id.includes(query) || query.includes(id) || id[0] === query[0],
    )
    .slice(0, 3);

const findProduct = (catalog: Catalog, product: string) => {
  const id = product.trim().toLowerCase();
  const grid = catalog.get(id);
  if (grid) return { ok: true as const, grid };
  const close = closestIds(catalog, id);
  const hint = close.length > 0 ? ` Closest ids: ${close.join(", ")}.` : "";
  return {
    ok: false as const,
    outcome: notFound(
      `Unknown product id "${product}".${hint} Use list_products.`,
    ),
  };
};

const roundCents = (value: number) => Math.round(value * 100) / 100;

const listProducts: ToolDefinition<Record<string, never>> = {
  name: "list_products",
  description:
    "List every product in the catalog as {id, name}. Use it only when the question does not name a product, for example to compare products.",
  args: z.object({}).strict(),
  handler: (_args, catalog) => ({
    ok: true,
    data: [...catalog].map(([id, grid]) => ({ id, name: grid.product })),
  }),
};

const getPlans: ToolDefinition<{ product: string }> = {
  name: "get_plans",
  description:
    "Get the plans of one product by id (the product name in lowercase, for example notion) with their prices: amount, currency, period, unit (user, workspace or flat) and billing (monthly or annual).",
  args: z.object({ product: z.string().min(1) }),
  handler: (args, catalog) => {
    const found = findProduct(catalog, args.product);
    if (!found.ok) return found.outcome;
    return {
      ok: true,
      data: {
        product: found.grid.product,
        plans: found.grid.plans.map(({ name, isFree, prices }) => ({
          name,
          isFree,
          prices,
        })),
      },
    };
  },
};

const PriceArgs = z.object({
  product: z.string().min(1),
  plan: z.string().min(1),
  seats: z.number().int().min(1).max(1000),
  billing: Billing,
});

const priceForSeats: ToolDefinition<z.infer<typeof PriceArgs>> = {
  name: "price_for_seats",
  description:
    "Compute what one plan costs for a number of seats and a billing option (monthly or annual). Returns perMonth and perYear. Use it for every amount; never compute prices yourself.",
  args: PriceArgs,
  handler: (args, catalog) => {
    const found = findProduct(catalog, args.product);
    if (!found.ok) return found.outcome;
    const plan = found.grid.plans.find(
      (candidate) =>
        candidate.name.toLowerCase() === args.plan.trim().toLowerCase(),
    );
    if (!plan) {
      const names = found.grid.plans
        .map((candidate) => candidate.name)
        .join(", ");
      return notFound(
        `Unknown plan "${args.plan}" for ${args.product}. Plans: ${names}.`,
      );
    }
    const price = plan.prices.find(
      (candidate) => candidate.billing === args.billing,
    );
    if (!price) {
      const options =
        plan.prices.map((candidate) => candidate.billing).join(", ") || "none";
      return notFound(
        `${plan.name} has no ${args.billing} price. Billing options: ${options}.`,
      );
    }
    const multiplier = price.unit === "user" ? args.seats : 1;
    const perPeriod = price.amount * multiplier;
    const perYear = price.period === "month" ? perPeriod * 12 : perPeriod;
    return {
      ok: true,
      data: {
        perMonth: roundCents(perYear / 12),
        perYear: roundCents(perYear),
        currency: price.currency,
        unit: price.unit,
        billing: price.billing,
      },
    };
  },
};

export const FinalAnswerArgs = z.object({
  answer: z.string().min(1),
  amounts: z.array(z.number()),
});

export const FINAL_ANSWER = "final_answer";

const finalAnswer: ToolDefinition<z.infer<typeof FinalAnswerArgs>> = {
  name: FINAL_ANSWER,
  description:
    "Give the final answer and stop. List in amounts every number of money quoted in the answer; each must come from an earlier tool result.",
  args: FinalAnswerArgs,
  handler: (args) => ({ ok: true, data: args }),
};

export const TOOLS: readonly ToolDefinition[] = [
  listProducts,
  getPlans,
  priceForSeats,
  finalAnswer,
];

const collectNumbers = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(collectNumbers);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectNumbers);
  }
  return [];
};

export const unseenAmounts = (
  amounts: readonly number[],
  priorResults: readonly unknown[],
) => {
  const seen = priorResults.flatMap(collectNumbers);
  return amounts.filter(
    (amount) => !seen.some((value) => Math.abs(value - amount) < 0.005),
  );
};

export const toOllamaTools = (tools: readonly ToolDefinition[]) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.args),
    },
  }));
