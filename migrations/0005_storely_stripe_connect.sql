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
CREATE UNIQUE INDEX `stripe_connect_user_idx` ON `stripe_connect_accounts` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connect_account_idx` ON `stripe_connect_accounts` (`stripe_account_id`);
--> statement-breakpoint
CREATE INDEX `stripe_connect_status_idx` ON `stripe_connect_accounts` (`account_status`);
