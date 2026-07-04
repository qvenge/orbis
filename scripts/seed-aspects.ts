// scripts/seed-aspects.ts — upsert builtin-аспектов; только DATABASE_URL_ADMIN.
import { aspectJsonSchema, BUILTIN_ASPECT_META } from '@orbis/shared';
import postgres from 'postgres';

const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) throw new Error('seed-aspects: DATABASE_URL_ADMIN не задан');
const sql = postgres(admin, { max: 1 });
try {
  for (const meta of BUILTIN_ASPECT_META) {
    await sql`
      INSERT INTO aspect_definitions
        (id, owner_id, name, namespace, description, icon, schema,
         ai_instructions, tag_mappings, view_config)
      VALUES
        (${meta.id}, NULL, ${meta.name}, ${meta.namespace}, ${meta.description},
         ${meta.icon}, ${sql.json(aspectJsonSchema(meta.id))}, ${meta.aiInstructions},
         ${meta.tagMappings}, ${sql.json(meta.viewConfig)})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
        schema = EXCLUDED.schema, ai_instructions = EXCLUDED.ai_instructions,
        tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config`;
  }
  console.log(`seed-aspects: ${BUILTIN_ASPECT_META.length} builtin-аспектов upsert'нуто`);
} finally {
  await sql.end();
}
