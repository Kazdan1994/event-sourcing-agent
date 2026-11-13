import { describe, expect, test } from "bun:test";
import type { PricingGrid } from "../pricing/schema.ts";
import type { Catalog } from "./catalog.ts";
import { TOOLS, toOllamaTools, unseenAmounts } from "./tools.ts";

const notion: PricingGrid = {
  product: "Notion",
  plans: [
    { name: "Free", isFree: true, limits: [], prices: [] },
    {
      name: "Plus",
      isFree: false,
      limits: [{ label: "Blocks", value: "Unlimited" }],
      prices: [
        {
          amount: 9.5,
          currency: "EUR",
          period: "month",
          unit: "user",
          billing: "monthly",
        },
      ],
    },
  ],
};

const tally: PricingGrid = {
  product: "Tally",
  plans: [
    {
      name: "Pro",
      isFree: false,
      limits: [],
      prices: [
        {
          amount: 290,
          currency: "EUR",
          period: "year",
          unit: "flat",
          billing: "annual",
        },
      ],
    },
  ],
};

export const CATALOG: Catalog = new Map([
  ["notion", notion],
  ["tally", tally],
]);

const tool = (name: string) => {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

describe("list_products", () => {
  test("returns ids and names", () => {
    expect(tool("list_products").handler({}, CATALOG)).toEqual({
      ok: true,
      data: [
        { id: "notion", name: "Notion" },
        { id: "tally", name: "Tally" },
      ],
    });
  });
});

describe("get_plans", () => {
  test("omits limits", () => {
    const outcome = tool("get_plans").handler({ product: "notion" }, CATALOG);
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("Blocks");
  });

  test("unknown product is not_found with a hint", () => {
    const outcome = tool("get_plans").handler({ product: "notio" }, CATALOG);
    expect(outcome).toMatchObject({ ok: false, kind: "not_found" });
    expect(JSON.stringify(outcome)).toContain("notion");
  });
});

describe("price_for_seats", () => {
  const price = tool("price_for_seats");

  test("per-user monthly price times seats", () => {
    expect(
      price.handler(
        { product: "notion", plan: "plus", seats: 5, billing: "monthly" },
        CATALOG,
      ),
    ).toEqual({
      ok: true,
      data: {
        perMonth: 47.5,
        perYear: 570,
        currency: "EUR",
        unit: "user",
        billing: "monthly",
      },
    });
  });

  test("flat yearly price ignores seats", () => {
    expect(
      price.handler(
        { product: "tally", plan: "Pro", seats: 40, billing: "annual" },
        CATALOG,
      ),
    ).toMatchObject({
      ok: true,
      data: { perYear: 290, perMonth: 24.17 },
    });
  });

  test("unknown plan and missing billing are not_found", () => {
    expect(
      price.handler(
        { product: "notion", plan: "Max", seats: 1, billing: "monthly" },
        CATALOG,
      ),
    ).toMatchObject({
      ok: false,
      kind: "not_found",
    });
    expect(
      price.handler(
        { product: "notion", plan: "Plus", seats: 1, billing: "annual" },
        CATALOG,
      ),
    ).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  test("seats outside 1..1000 fail the schema", () => {
    expect(
      price.args.safeParse({
        product: "notion",
        plan: "Plus",
        seats: 0,
        billing: "monthly",
      }).success,
    ).toBe(false);
    expect(
      price.args.safeParse({
        product: "notion",
        plan: "Plus",
        seats: 2.5,
        billing: "monthly",
      }).success,
    ).toBe(false);
  });
});

describe("unseenAmounts", () => {
  test("keeps amounts not found in prior results", () => {
    expect(
      unseenAmounts(
        [570, 99],
        [{ perYear: 570, nested: [{ perMonth: 47.5 }] }],
      ),
    ).toEqual([99]);
  });
});

describe("toOllamaTools", () => {
  test("parameters come from the Zod schemas", () => {
    const [, getPlans] = toOllamaTools(TOOLS);
    expect(getPlans?.function.parameters).toMatchObject({
      type: "object",
      required: ["product"],
    });
  });
});
