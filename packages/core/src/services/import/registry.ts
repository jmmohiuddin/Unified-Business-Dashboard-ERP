import { ServiceError } from "../context.ts";
import { chequesImporter } from "./cheques.ts";
import { debtsImporter } from "./debts.ts";
import { employeesImporter } from "./employees.ts";
import { leasesImporter } from "./leases.ts";
import { openingBalancesImporter } from "./opening-balances.ts";
import { partiesImporter } from "./parties.ts";
import { stockImporter } from "./stock.ts";
import { unitsImporter } from "./units.ts";
import { IMPORT_KINDS, type ImportKind, type Importer } from "./types.ts";

/**
 * THE IMPORTERS, AND THE ORDER THEY HAVE TO RUN IN.
 *
 * Order is not a preference. Each importer refuses to invent the records it
 * points at — a lease will not conjure a tenant, a cheque will not conjure a
 * lease — because inventing them is how a portfolio ends up with two Ahmeds and
 * every subsequent payment landing against the wrong one. The consequence is
 * that running them out of order produces a file of rejected rows, so the order
 * is published rather than left for the user to discover.
 *
 * Opening balances come FIRST because everything downstream reconciles against
 * them: the receivables control account, the cheques on hand, the inventory
 * value. Nothing after it posts to the ledger.
 */
export const IMPORTERS: Record<ImportKind, Importer> = {
  opening_balances: openingBalancesImporter,
  parties: partiesImporter,
  units: unitsImporter,
  leases: leasesImporter,
  debts: debtsImporter,
  cheques: chequesImporter,
  stock: stockImporter,
  employees: employeesImporter,
};

/** Presentation order, which is also the order they must be run in. */
export const IMPORT_ORDER: ImportKind[] = [
  "opening_balances",
  "parties",
  "units",
  "leases",
  "debts",
  "cheques",
  "stock",
  "employees",
];

export function isImportKind(value: string): value is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(value);
}

export function importerFor(kind: string): Importer {
  if (!isImportKind(kind)) {
    throw new ServiceError(`"${kind}" is not something this can import.`, "invalid");
  }
  return IMPORTERS[kind];
}

/**
 * The header row of a blank template.
 *
 * Offered because the alternative — an accountant guessing at column names from
 * a screenshot — produces a file of rejected rows and a support conversation.
 * Quoted so a header containing a delimiter survives the round trip.
 */
export function templateCsv(kind: string): string {
  const importer = importerFor(kind);
  return `${importer.template.map((c) => `"${c}"`).join(",")}\n`;
}
