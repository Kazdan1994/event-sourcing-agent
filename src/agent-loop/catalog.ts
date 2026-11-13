import { readdir } from "node:fs/promises";
import { ANNOTATIONS_DIR } from "../pricing/paths.ts";
import { PricingGrid } from "../pricing/schema.ts";

export type Catalog = ReadonlyMap<string, PricingGrid>;

const SUFFIX = ".expected.json";

export const loadCatalog = async (): Promise<Catalog> => {
  const files = (await readdir(ANNOTATIONS_DIR))
    .filter((file) => file.endsWith(SUFFIX) && !file.startsWith("_"))
    .sort();
  const entries = await Promise.all(
    files.map(async (file) => {
      const raw: unknown = await Bun.file(
        new URL(file, ANNOTATIONS_DIR),
      ).json();
      const parsed = PricingGrid.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid annotation ${file}: ${parsed.error.message}`);
      }
      return [file.slice(0, -SUFFIX.length), parsed.data] as const;
    }),
  );
  return new Map(entries);
};
