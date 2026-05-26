WITH fixed_fields AS (
  SELECT
    source.id,
    jsonb_object_agg(
      param.key,
      jsonb_build_object(
        'type', 'FIXED',
        'source', 'FIXED',
        'value', param.value,
        'description', 'Always sent with this action.'
      )
    ) AS migrated_schema
  FROM "public"."AgentActionSource" AS source
  CROSS JOIN LATERAL jsonb_each_text(source."queryParams") AS param(key, value)
  WHERE
    source."queryParams" IS NOT NULL
    AND jsonb_typeof(source."queryParams") = 'object'
    AND param.key <> ''
    AND param.value <> ''
    AND NOT (COALESCE(source."expectedParamsSchema", '{}'::jsonb) ? param.key)
  GROUP BY source.id
)
UPDATE "public"."AgentActionSource" AS source
SET "expectedParamsSchema" = COALESCE(source."expectedParamsSchema", '{}'::jsonb) || fixed_fields.migrated_schema
FROM fixed_fields
WHERE source.id = fixed_fields.id;

ALTER TABLE "public"."AgentActionSource"
DROP COLUMN IF EXISTS "queryParams";
