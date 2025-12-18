CREATE TABLE `stripe_connect_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_account_id` text NOT NULL,
	`account_status` text DEFAULT 'pending' NOT NULL,
	`charges_enabled` integer DEFAULT false,
	`payouts_enabled` integer DEFAULT false,
	`details_submitted` integer DEFAULT false,
	`default_currency` text,
	`country` text,
	`business_profile` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connect_accounts_stripe_account_id_unique` ON `stripe_connect_accounts` (`stripe_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connect_user_idx` ON `stripe_connect_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connect_account_idx` ON `stripe_connect_accounts` (`stripe_account_id`);--> statement-breakpoint
CREATE INDEX `stripe_connect_status_idx` ON `stripe_connect_accounts` (`account_status`);--> statement-breakpoint
CREATE TABLE `user_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text,
	`domain` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_domains_user_idx` ON `user_domains` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_domains_app_idx` ON `user_domains` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_domains_domain_idx` ON `user_domains` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_domains_user_domain_idx` ON `user_domains` (`user_id`,`domain`);--> statement-breakpoint
ALTER TABLE `apps` ADD `custom_subdomain` text;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_custom_subdomain_idx` ON `apps` (`custom_subdomain`);