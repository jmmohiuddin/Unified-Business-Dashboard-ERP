CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"trade_name" varchar(200),
	"tax_identification_number" varchar(20),
	"tax_registered_on" date,
	"corporate_tax_registration_no" varchar(30),
	"trade_license_no" varchar(40),
	"licensing_authority" varchar(80),
	"trade_license_expiry" date,
	"establishment_card_no" varchar(40),
	"establishment_card_expiry" date,
	"is_free_zone" boolean DEFAULT false NOT NULL,
	"is_designated_zone" boolean DEFAULT false NOT NULL,
	"fiscal_year_end_month" integer DEFAULT 12 NOT NULL,
	"fiscal_year_end_day" integer DEFAULT 31 NOT NULL,
	"registered_address" text,
	"emirate" varchar(40) DEFAULT 'Dubai' NOT NULL,
	"country_code" varchar(2) DEFAULT 'AE' NOT NULL,
	"einvoice_provider_key" varchar(40),
	"einvoice_provider_appointed_on" date,
	"einvoice_live_from" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"role_id" uuid NOT NULL,
	"scope" "scope_level" DEFAULT 'tenant' NOT NULL,
	"business_unit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vat_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_label" varchar(20) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_on" date,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"emirate" varchar(40),
	"apportionment_method" varchar(20) DEFAULT 'standard' NOT NULL,
	"apportionment_basis" varchar(20) DEFAULT 'supplies_value' NOT NULL,
	"fta_approval_reference" varchar(60),
	"recovery_ratio" numeric(9, 6) DEFAULT '1' NOT NULL,
	"standard_rated_supplies" numeric(18, 4) DEFAULT '0' NOT NULL,
	"output_vat" numeric(18, 4) DEFAULT '0' NOT NULL,
	"zero_rated_supplies" numeric(18, 4) DEFAULT '0' NOT NULL,
	"exempt_supplies" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reverse_charge_supplies" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reverse_charge_output_vat" numeric(18, 4) DEFAULT '0' NOT NULL,
	"directly_attributable_input" numeric(18, 4) DEFAULT '0' NOT NULL,
	"residual_input" numeric(18, 4) DEFAULT '0' NOT NULL,
	"recoverable_residual" numeric(18, 4) DEFAULT '0' NOT NULL,
	"exempt_attributable_input" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_recoverable_input" numeric(18, 4) DEFAULT '0' NOT NULL,
	"irrecoverable_input" numeric(18, 4) DEFAULT '0' NOT NULL,
	"net_vat_due" numeric(18, 4) DEFAULT '0' NOT NULL,
	"washup_adjustment" numeric(18, 4),
	"washup_journal_id" uuid,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filed_at" timestamp with time zone,
	"filed_by_user_id" uuid,
	"fta_submission_reference" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batch_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"row_number" integer NOT NULL,
	"action" varchar(10) NOT NULL,
	"entity_table" varchar(63) NOT NULL,
	"entity_id" uuid NOT NULL,
	"previous" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"kind" varchar(30) NOT NULL,
	"source_filename" varchar(250) NOT NULL,
	"source_fingerprint" varchar(64) NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"total_debit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_credit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"expected_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"journal_id" uuid,
	"reversal_journal_id" uuid,
	"committed_by_user_id" uuid,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversible_until" timestamp with time zone NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"reversal_reason" text,
	"signed_off_at" timestamp with time zone,
	"signed_off_by_user_id" uuid,
	"signed_off_total" numeric(18, 4),
	"sign_off_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "business_units" ADD COLUMN "legal_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD CONSTRAINT "vat_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD CONSTRAINT "vat_returns_washup_journal_id_journals_id_fk" FOREIGN KEY ("washup_journal_id") REFERENCES "public"."journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD CONSTRAINT "vat_returns_filed_by_user_id_users_id_fk" FOREIGN KEY ("filed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_committed_by_user_id_users_id_fk" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_signed_off_by_user_id_users_id_fk" FOREIGN KEY ("signed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_tenant_code_uq" ON "legal_entities" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "legal_entities_tenant_idx" ON "legal_entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invites_token_uq" ON "user_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invites_pending_uq" ON "user_invites" USING btree ("tenant_id","email") WHERE accepted_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vat_returns_period_uq" ON "vat_returns" USING btree ("tenant_id","period_label");--> statement-breakpoint
CREATE INDEX "vat_returns_status_idx" ON "vat_returns" USING btree ("tenant_id","status","period_start");--> statement-breakpoint
CREATE INDEX "import_batch_rows_batch_idx" ON "import_batch_rows" USING btree ("batch_id","seq");--> statement-breakpoint
CREATE INDEX "import_batch_rows_entity_idx" ON "import_batch_rows" USING btree ("entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "import_batches_tenant_idx" ON "import_batches" USING btree ("tenant_id","committed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_fingerprint_uq" ON "import_batches" USING btree ("tenant_id","kind","source_fingerprint") WHERE reversed_at IS NULL;--> statement-breakpoint
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;