/**
 * DATA MIGRATION — FR-D01.
 *
 * The import wizard: dry run, diff, explicit commit, reconciliation, the
 * accountant's sign-off, and reversal as a batch. See `batches.ts` for the
 * guarantees each of those carries, and `registry.ts` for the order the
 * importers must be run in.
 *
 * Exported as a group rather than piecemeal so a caller cannot reach an
 * importer's `apply` without going through `commitImport` — which is the only
 * path that takes an approval, opens a batch, and records what it wrote.
 */
export {
  REVERSIBLE_HOURS,
  buildReconciliation,
  commitImport,
  commitImportInput,
  importGoLiveStatus,
  listImportBatches,
  previewImport,
  previewImportInput,
  reverseBatchInput,
  reverseImportBatch,
  signOffInput,
  signOffReconciliation,
  type CommitImportResult,
  type ControlCheck,
  type GoLiveStatus,
  type ImportBatchSummary,
  type ReconciliationLine,
  type ReconciliationReport,
  type ReverseBatchResult,
  type SignOffResult,
} from "./batches.ts";

export { IMPORTERS, IMPORT_ORDER, importerFor, isImportKind, templateCsv } from "./registry.ts";

export { MAX_ROWS } from "./source.ts";

export {
  IMPORT_KINDS,
  type DiffCounts,
  type DiffRow,
  type DiffTotal,
  type ImportDiff,
  type ImportKind,
  type ImportOptions,
  type Importer,
  type RowIssue,
} from "./types.ts";
