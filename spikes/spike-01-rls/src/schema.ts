import { pgTable, uuid, text } from 'drizzle-orm/pg-core';

export const spikeItems = pgTable('spike_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
});
