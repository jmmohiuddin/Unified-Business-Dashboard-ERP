import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  automationTrigger,
  channelKind,
  fulfilmentStatus,
  insightSeverity,
  insightStatus,
  notificationChannel,
  runStatus,
} from "./_enums.ts";
import { metadata, money, pk, qty, rate, timestamps } from "./_shared.ts";
import { businessUnits, tenants } from "./tenancy.ts";
import { users } from "./identity.ts";
import { parties } from "./parties.ts";
import { items } from "./catalog.ts";

// ════════════════════════════════════════════════════════════════════════════
//  COMMERCE CHANNELS
// ════════════════════════════════════════════════════════════════════════════

/** Where an order came from: own site, Daraz/Facebook, the counter, the phone.
 *  Channel-level margin is the report that tells the owner which channel is
 *  actually profitable after commission and returns. */
export const channels = pgTable(
  "channels",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    kind: channelKind("kind").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** Marketplace take rate, so net revenue is right without a manual journal. */
    commissionRate: rate("commission_rate").notNull().default("0"),
    externalAccountRef: varchar("external_account_ref", { length: 120 }),
    credentialsRef: varchar("credentials_ref", { length: 120 }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncCursor: varchar("sync_cursor", { length: 200 }),
    isActive: boolean("is_active").notNull().default(true),
    settings: metadata("settings"),
    ...timestamps,
  },
  (t) => [index("channels_bu_idx").on(t.businessUnitId)],
);

export const channelListings = pgTable(
  "channel_listings",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id"),
    externalId: varchar("external_id", { length: 120 }).notNull(),
    listedPrice: money("listed_price"),
    /** Ring-fenced stock so the shop floor cannot sell the last unit that the
     *  website already promised. */
    allocatedStock: qty("allocated_stock"),
    isPublished: boolean("is_published").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncError: text("sync_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_listings_uq").on(t.channelId, t.externalId)],
);

export const fulfilments = pgTable(
  "fulfilments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    status: fulfilmentStatus("status").notNull().default("pending"),
    carrier: varchar("carrier", { length: 80 }),
    trackingNumber: varchar("tracking_number", { length: 120 }),
    shippingCost: money("shipping_cost").notNull().default("0"),
    /** Cash on delivery dominates this market; the COD float is real working
     *  capital sitting with the courier and must be visible in cash flow. */
    isCod: boolean("is_cod").notNull().default(false),
    codAmount: money("cod_amount").notNull().default("0"),
    codSettledOn: date("cod_settled_on"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnReason: varchar("return_reason", { length: 200 }),
    ...timestamps,
  },
  (t) => [
    index("fulfilments_doc_idx").on(t.documentId),
    index("fulfilments_status_idx").on(t.tenantId, t.status),
  ],
);

// ════════════════════════════════════════════════════════════════════════════
//  MARKETING
// ════════════════════════════════════════════════════════════════════════════

export const campaigns = pgTable(
  "campaigns",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 200 }).notNull(),
    channel: notificationChannel("channel").notNull().default("sms"),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    /** Stored as a saved segment definition, re-evaluated at send time so the
     *  audience is never stale. */
    segmentQuery: metadata("segment_query"),
    templateBody: text("template_body"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    audienceCount: integer("audience_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    responseCount: integer("response_count").notNull().default(0),
    /** Attribution window in days; revenue is matched back from documents. */
    attributionWindowDays: integer("attribution_window_days").notNull().default(14),
    attributedRevenue: money("attributed_revenue").notNull().default("0"),
    cost: money("cost").notNull().default("0"),
    ...timestamps,
  },
  (t) => [index("campaigns_bu_idx").on(t.businessUnitId, t.status)],
);

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    convertedDocumentId: uuid("converted_document_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("campaign_recipients_uq").on(t.campaignId, t.partyId)],
);

// ════════════════════════════════════════════════════════════════════════════
//  AUTOMATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Automations are DATA, not code. Every workflow the brief asked for — send
 * invoices, chase payments, reorder stock, request reviews, escalate SLA
 * breaches — is one row here. That is what makes the feature list finite: the
 * engine is built once and the owner adds rules.
 *
 * `conditions` and `actions` are validated against a Zod registry at save time,
 * so a malformed automation is rejected before it can run.
 */
export const automations = pgTable(
  "automations",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    trigger: automationTrigger("trigger").notNull(),
    /** cron for schedule triggers; table+event for record triggers. */
    triggerConfig: metadata("trigger_config"),
    conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
    actions: jsonb("actions").notNull().default(sql`'[]'::jsonb`),
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** Safety rail: an automation that suddenly wants to text 4,000 customers
     *  gets held for approval instead of running. */
    maxRunsPerDay: integer("max_runs_per_day").notNull().default(500),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("automations_next_run_idx").on(t.isEnabled, t.nextRunAt),
    index("automations_tenant_idx").on(t.tenantId),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    matchedCount: integer("matched_count").notNull().default(0),
    actionCount: integer("action_count").notNull().default(0),
    error: text("error"),
    /** Enough detail that the owner can answer "why did my customer get this?" */
    log: jsonb("log").notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (t) => [index("automation_runs_automation_idx").on(t.automationId, t.startedAt)],
);

/**
 * Communication consent.
 *
 * A hard opt-out ledger, checked before ANY outbound message to a customer or
 * tenant. This exists before a single SMS provider is connected, and that
 * ordering is deliberate: bolting consent on after you already have a sending
 * pipeline is how businesses end up messaging people who asked them to stop.
 *
 * An absent row means "no explicit preference" — transactional messages (your
 * invoice, your appointment) may still go, marketing may not. A row with
 * `optedOutAt` set blocks everything on that channel.
 */
export const communicationConsents = pgTable(
  "communication_consents",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    /** Transactional messages are permitted unless explicitly withdrawn. */
    allowsTransactional: boolean("allows_transactional").notNull().default(true),
    /** Marketing requires an affirmative opt-in, never assumed. */
    allowsMarketing: boolean("allows_marketing").notNull().default(false),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    optedOutReason: varchar("opted_out_reason", { length: 200 }),
    /** Proof of consent, for a regulator or a complaint. */
    source: varchar("source", { length: 60 }),
    ...timestamps,
  },
  (t) => [uniqueIndex("comm_consent_uq").on(t.partyId, t.channel)],
);

/** Outbound message queue — one row per notification, whatever the channel. */
export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull().default("in_app"),
    recipientUserId: uuid("recipient_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    recipientPartyId: uuid("recipient_party_id").references(() => parties.id, {
      onDelete: "cascade",
    }),
    recipientAddress: varchar("recipient_address", { length: 320 }),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body"),
    /** Deep link into the app — every alert must be one tap from the fix. */
    actionUrl: text("action_url"),
    severity: insightSeverity("severity").notNull().default("info"),
    sourceTable: varchar("source_table", { length: 63 }),
    sourceId: uuid("source_id"),
    /** Prevents the same reminder being sent twice by two workers. */
    dedupeKey: varchar("dedupe_key", { length: 160 }),
    status: runStatus("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    error: text("error"),

    /** Outbox delivery state. Retries are bounded and backed off, because a
     *  provider outage must not turn into a thousand-message replay. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    provider: varchar("provider", { length: 40 }),
    providerMessageId: varchar("provider_message_id", { length: 160 }),
    /** Set when consent or quiet hours blocked the send — a suppression is not
     *  a failure, and conflating the two hides real delivery problems. */
    suppressedReason: varchar("suppressed_reason", { length: 120 }),
    /** Transactional messages ignore marketing opt-out; marketing does not. */
    isMarketing: boolean("is_marketing").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.tenantId, t.dedupeKey),
    index("notifications_user_idx").on(t.recipientUserId, t.readAt),
    index("notifications_outbox_idx").on(t.status, t.nextAttemptAt),
  ],
);

// ════════════════════════════════════════════════════════════════════════════
//  ANALYTICS & AI
// ════════════════════════════════════════════════════════════════════════════

/**
 * Nightly pre-aggregated facts, one row per (date, business, metric).
 *
 * The dashboard MUST NOT aggregate the transaction tables on page load. At
 * thousands of tenants and millions of documents that is the difference between
 * a 90 ms dashboard and a 9 s one. Live "today" figures come from the hot
 * tables; everything historical reads from here.
 */
export const kpiSnapshots = pgTable(
  "kpi_snapshots",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    onDate: date("on_date").notNull(),
    metricKey: varchar("metric_key", { length: 60 }).notNull(),
    value: money("value").notNull().default("0"),
    /** Same metric one period earlier, stored so trend arrows need no join. */
    priorValue: money("prior_value"),
    breakdown: metadata("breakdown"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kpi_snapshots_uq").on(t.tenantId, t.businessUnitId, t.onDate, t.metricKey),
    index("kpi_snapshots_metric_idx").on(t.tenantId, t.metricKey, t.onDate),
  ],
);

/**
 * AI-generated findings. Persisted rather than produced on demand because:
 *  - the owner must be able to act on the same insight tomorrow;
 *  - "was this useful?" feedback is the only way the recommender improves;
 *  - regenerating a full portfolio analysis on every page load is expensive.
 *
 * `evidence` holds the metric ids + values behind the claim so every insight is
 * clickable back to real rows. An insight the owner cannot verify is a liability.
 */
export const aiInsights = pgTable(
  "ai_insights",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    kind: varchar("kind", { length: 40 }).notNull(),
    severity: insightSeverity("severity").notNull().default("info"),
    status: insightStatus("status").notNull().default("new"),
    title: varchar("title", { length: 250 }).notNull(),
    body: text("body").notNull(),
    /** The single action to take, rendered as a button. An insight with no
     *  action is trivia. */
    recommendedAction: text("recommended_action"),
    actionUrl: text("action_url"),
    /** Money at stake — used to rank the feed. */
    impactAmount: money("impact_amount"),
    confidence: rate("confidence"),
    evidence: metadata("evidence"),
    modelId: varchar("model_id", { length: 60 }),
    validUntil: date("valid_until"),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    feedback: varchar("feedback", { length: 20 }),
    ...timestamps,
  },
  (t) => [
    index("ai_insights_feed_idx").on(t.tenantId, t.status, t.severity),
    index("ai_insights_bu_idx").on(t.businessUnitId, t.createdAt),
  ],
);

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }),
    businessUnitId: uuid("business_unit_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("ai_conversations_user_idx").on(t.userId, t.lastMessageAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content"),
    /** Which semantic-layer metrics were called and what they returned. This is
     *  the audit trail that makes an AI answer defensible. */
    toolCalls: jsonb("tool_calls").notNull().default(sql`'[]'::jsonb`),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms"),
    modelId: varchar("model_id", { length: 60 }),
    ...timestamps,
  },
  (t) => [index("ai_messages_conv_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Documents the AI extracted structured data from: supplier bills, receipts,
 * handwritten job sheets. `extracted` is never trusted directly — it becomes a
 * DRAFT the human confirms. `confidence` drives how loudly we ask.
 *
 * This is the single highest-ROI AI feature for an owner coming off paper, and
 * the reason it ranks above chatbots in the roadmap.
 */
export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    fileUrl: text("file_url").notNull(),
    fileHash: varchar("file_hash", { length: 64 }),
    kind: varchar("kind", { length: 30 }).notNull().default("bill"),
    status: runStatus("status").notNull().default("pending"),
    extracted: metadata("extracted"),
    confidence: rate("confidence"),
    /** Set once a human accepts it and it becomes a real document. */
    createdDocumentId: uuid("created_document_id"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("doc_extractions_hash_uq").on(t.tenantId, t.fileHash),
    index("doc_extractions_status_idx").on(t.tenantId, t.status),
  ],
);

/** Generic file attachments for any entity. */
export const attachments = pgTable(
  "attachments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    entityTable: varchar("entity_table", { length: 63 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    fileName: varchar("file_name", { length: 250 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }),
    sizeBytes: integer("size_bytes"),
    storageKey: text("storage_key").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [index("attachments_entity_idx").on(t.entityTable, t.entityId)],
);

/**
 * Idempotency keys.
 *
 * The client supplies a key with every mutation; a replayed request returns the
 * stored result instead of running again. This is not a nicety — staff record
 * payments from a phone in a basement car park, and the dominant failure mode
 * is a request that succeeded on the server and timed out on the client. Without
 * this, the natural user response (tap it again) takes the money twice.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 120 }).notNull(),
    operation: varchar("operation", { length: 60 }).notNull(),
    /** The original response, replayed verbatim on a retry. */
    result: metadata("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_uq").on(t.tenantId, t.key)],
);

/** Saved views: the owner's own filtered lists and custom dashboards. */
export const savedViews = pgTable(
  "saved_views",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopeKey: varchar("scope_key", { length: 60 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    config: metadata("config"),
    isShared: boolean("is_shared").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("saved_views_scope_idx").on(t.tenantId, t.scopeKey)],
);

export const automationsRelations = relations(automations, ({ many }) => ({
  runs: many(automationRuns),
}));

export const aiConversationsRelations = relations(aiConversations, ({ many }) => ({
  messages: many(aiMessages),
}));

/**
 * SCHEDULER RUN LOG.
 *
 * The automation runner, the notification outbox, the daily briefing and the
 * KPI snapshot job were all built and all inert — each required a human to run
 * a CLI command. An automation platform that only runs when someone remembers
 * to run it does not automate anything.
 *
 * Deliberately NOT tenant-scoped: a scheduled job sweeps every tenant, and a
 * run that failed before it resolved a tenant still has to be recorded. It
 * carries no tenant data — job name, timing, outcome, counts.
 *
 * The row is also the lock. Claiming a run is an INSERT guarded by a partial
 * unique index on (job) WHERE finished_at IS NULL, so two overlapping cron
 * invocations cannot both run the same job: the second insert simply fails.
 * That is a distributed lock without adding Redis to the deployment.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: pk(),
    job: varchar("job", { length: 40 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    /** Tenants swept, records touched — whatever the job counts. */
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("job_runs_job_idx").on(t.job, t.startedAt),
    // One in-flight run per job, enforced by the database rather than by hope.
    uniqueIndex("job_runs_inflight_uq").on(t.job).where(sql`finished_at IS NULL`),
  ],
);

// ════════════════════════════════════════════════════════════════════════════
//  DATA MIGRATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * One run of the import wizard that actually committed.
 *
 * Dry runs are NOT recorded here. A dry run writes nothing at all, so there is
 * nothing to reverse and nothing to be idempotent about; giving it a row would
 * create a second, weaker meaning for "this batch exists" on the one screen
 * where that phrase has to mean "this is in your books".
 *
 * Three jobs, each of which is a PRD acceptance criterion for FR-D01 rather
 * than bookkeeping for its own sake:
 *
 *  1. REVERSIBILITY (72 hours). Migrated opening data being wrong is risk R2 at
 *     critical severity, and the failure mode is not "the import crashed" — it
 *     is "the import succeeded and the numbers are wrong", discovered two days
 *     later by the accountant. `reversible_until` is the window; the rows the
 *     batch touched are in `import_batch_rows`, because a reversal that cannot
 *     name what it is undoing is a guess.
 *
 *  2. IDEMPOTENCY. `source_fingerprint` is a digest of the file's meaningful
 *     content, and the partial unique index over it refuses a second commit of
 *     the same file into the same tenant while the first is still live. The
 *     database arbitrates, not application code: re-uploading the same
 *     spreadsheet after a timeout is the single most likely way an accountant
 *     doubles their opening balances.
 *
 *  3. SIGN-OFF. Decision D5 makes the accountant's signed reconciliation a
 *     go-live gate. `signed_off_at` is that gate, and `expected_lines` holds
 *     the figures the accountant's own file asserted, so the reconciliation can
 *     be re-derived line by line months later instead of being a screenshot.
 *
 * `total_debit` / `total_credit` are stored rather than recomputed because the
 * reconciliation has to compare what the file said against what the ledger
 * holds; recomputing both sides from the ledger compares the ledger with
 * itself and always ties.
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Null for kinds that are tenant-wide rather than per business. */
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    /** Which importer produced it: `opening_balances`, `parties`, … */
    kind: varchar("kind", { length: 30 }).notNull(),
    sourceFilename: varchar("source_filename", { length: 250 }).notNull(),
    /** SHA-256 over the normalised file body. See the unique index below. */
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),

    rowCount: integer("row_count").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),

    /** What the FILE asserted, in its own terms. Never recomputed. */
    totalDebit: money("total_debit").notNull().default("0"),
    totalCredit: money("total_credit").notNull().default("0"),
    /** The per-account figures the file supplied, for line-by-line reconciliation. */
    expectedLines: jsonb("expected_lines").notNull().default(sql`'[]'::jsonb`),

    /** Set only by importers that post to the ledger — opening balances. */
    journalId: uuid("journal_id"),
    reversalJournalId: uuid("reversal_journal_id"),

    committedByUserId: uuid("committed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    /** PRD FR-D01: "reversible as a batch for 72 hours after commit". */
    reversibleUntil: timestamp("reversible_until", { withTimezone: true }).notNull(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByUserId: uuid("reversed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reversalReason: text("reversal_reason"),

    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    signedOffByUserId: uuid("signed_off_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The figure the accountant supplied from their own records. */
    signedOffTotal: money("signed_off_total"),
    signOffNote: text("sign_off_note"),
    ...timestamps,
  },
  (t) => [
    index("import_batches_tenant_idx").on(t.tenantId, t.committedAt),
    // The idempotency guarantee. Partial on `reversed_at IS NULL` so a batch
    // that was reversed BECAUSE it was wrong can be corrected and re-uploaded —
    // refusing that would make the reversal a dead end.
    uniqueIndex("import_batches_fingerprint_uq")
      .on(t.tenantId, t.kind, t.sourceFingerprint)
      .where(sql`reversed_at IS NULL`),
  ],
);

/**
 * Every row a committed batch created or changed.
 *
 * This is what makes reversal reversal rather than a best guess. Two things it
 * has to record and one it deliberately does not:
 *
 *   RECORDS the table and primary key, so the reversal deletes exactly the rows
 *   the import made and nothing that merely resembles them. Matching on
 *   `created_at` or on the imported code would also catch a row the owner typed
 *   in by hand an hour later.
 *
 *   RECORDS the previous column values for an UPDATE, so reversing an update
 *   restores the value that was there before rather than blanking the field. An
 *   import that overwrote a credit limit and then "reversed" it to NULL has
 *   destroyed data, not restored it.
 *
 *   DOES NOT record ledger postings. A journal is never deleted — the opening
 *   balance is reversed by a second, opposite journal, which is what the rest of
 *   the ledger already does and what an auditor expects to find.
 *
 * `seq` preserves insertion order so the reversal can walk it backwards and
 * delete children before their parents, which is what lets the foreign keys do
 * the safety checking instead of application code.
 */
export const importBatchRows = pgTable(
  "import_batch_rows",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    /** Order applied. Reversal walks this descending. */
    seq: integer("seq").notNull(),
    /** 1-based line in the uploaded file, so an error names something the
     *  accountant can find in their spreadsheet. */
    rowNumber: integer("row_number").notNull(),
    action: varchar("action", { length: 10 }).notNull(),
    entityTable: varchar("entity_table", { length: 63 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** Column values as they were before an update. Empty for a create. */
    previous: metadata("previous"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("import_batch_rows_batch_idx").on(t.batchId, t.seq),
    index("import_batch_rows_entity_idx").on(t.entityTable, t.entityId),
  ],
);
