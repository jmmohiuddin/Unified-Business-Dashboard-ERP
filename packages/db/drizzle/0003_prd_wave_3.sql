CREATE TABLE "gratuity_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"settlement_number" varchar(40) NOT NULL,
	"reason" varchar(30) NOT NULL,
	"last_working_day" date NOT NULL,
	"settled_on" date NOT NULL,
	"joined_on" date NOT NULL,
	"service_period_start" date NOT NULL,
	"service_period_end" date NOT NULL,
	"unpaid_leave_days" integer DEFAULT 0 NOT NULL,
	"basic_salary" numeric(18, 4) NOT NULL,
	"total_salary" numeric(18, 4) NOT NULL,
	"service_days" integer NOT NULL,
	"service_years" numeric(18, 4) NOT NULL,
	"daily_basic_wage" numeric(18, 4) NOT NULL,
	"gratuity_days" numeric(18, 4) NOT NULL,
	"gratuity_gross" numeric(18, 4) NOT NULL,
	"gratuity_cap" numeric(18, 4),
	"gratuity_amount" numeric(18, 4) NOT NULL,
	"provision_applied" numeric(18, 4) DEFAULT '0' NOT NULL,
	"expense_shortfall" numeric(18, 4) DEFAULT '0' NOT NULL,
	"provision_released" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unpaid_salary" numeric(18, 4) DEFAULT '0' NOT NULL,
	"leave_encashment" numeric(18, 4) DEFAULT '0' NOT NULL,
	"notice_pay" numeric(18, 4) DEFAULT '0' NOT NULL,
	"other_earnings" numeric(18, 4) DEFAULT '0' NOT NULL,
	"advance_recovered" numeric(18, 4) DEFAULT '0' NOT NULL,
	"net_payable" numeric(18, 4) NOT NULL,
	"settled_via" varchar(20) DEFAULT 'bank_transfer' NOT NULL,
	"forfeiture_assumed" boolean DEFAULT false NOT NULL,
	"explanation" text NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journal_id" uuid,
	"settled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exception_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"exception_key" varchar(30) NOT NULL,
	"reason" text NOT NULL,
	"dismissed_count" integer NOT NULL,
	"dismissed_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"dismissed_depth_days" integer DEFAULT 0 NOT NULL,
	"scope_fingerprint" varchar(40) NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "service_restarted_on" date;--> statement-breakpoint
ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_settled_by_user_id_users_id_fk" FOREIGN KEY ("settled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_dismissals" ADD CONSTRAINT "exception_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_dismissals" ADD CONSTRAINT "exception_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gratuity_settlements_number_uq" ON "gratuity_settlements" USING btree ("tenant_id","settlement_number");--> statement-breakpoint
CREATE INDEX "gratuity_settlements_emp_idx" ON "gratuity_settlements" USING btree ("employee_id","service_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "exception_dismissals_live_uq" ON "exception_dismissals" USING btree ("tenant_id","user_id","exception_key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "exception_dismissals_user_idx" ON "exception_dismissals" USING btree ("tenant_id","user_id");