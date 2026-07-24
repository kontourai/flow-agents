/**
 * Minimal JSON Schema (2020-12 subset) validator shared by validate-workflow-artifacts.ts
 * (validating sidecar files already on disk) and workflow-sidecar.ts's `fixture write
 * --from-json` (validating a candidate fixture payload before it is ever written). Extracted
 * verbatim from validate-workflow-artifacts.ts's original `validateSchemaValue` so both
 * consumers share the EXACT same schema-matching logic — a second, independently-drifting
 * implementation would let "validates against workflow-state schema" mean two different things
 * depending on which CLI path a caller used.
 *
 * Supports: $ref (to #/$defs/* or an explicitly supplied schema registry),
 * allOf/anyOf/oneOf, if/then, const, enum, and the
 * string/boolean/integer/number/array/object primitive types with the small set of
 * keywords (minLength, format: date-time, minimum, minItems, uniqueItems, items,
 * required, properties, additionalProperties) the repo's own schemas/*.schema.json files use.
 * This is NOT a general-purpose JSON Schema implementation — it only covers the keyword subset
 * this repo's schemas actually use.
 */

export type Issue = { path: string; message: string };
export type SchemaRegistry = Readonly<Record<string, any>>;

const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function schemaMatches(value: unknown, schema: any, rootSchema: any, registry: SchemaRegistry): boolean {
  const issues: Issue[] = [];
  validateSchemaValue("<schema-match>", value, schema, "<value>", issues, rootSchema, registry);
  return issues.length === 0;
}

function validateSchemaCondition(value: unknown, schema: any, rootSchema: any, registry: SchemaRegistry): boolean {
  const issues: Issue[] = [];
  validateSchemaValue("<schema-condition>", value, schema, "<value>", issues, rootSchema, registry);
  return issues.length === 0;
}

function resolveSchemaRef(
  ref: string,
  rootSchema: any,
  registry: SchemaRegistry,
): { schema: any; rootSchema: any } | undefined {
  if (ref.startsWith("#/$defs/")) {
    const schema = rootSchema?.$defs?.[ref.slice("#/$defs/".length)];
    return schema ? { schema, rootSchema } : undefined;
  }
  const external = registry[ref];
  return external ? { schema: external, rootSchema: external } : undefined;
}

export function validateSchemaValue(
  file: string,
  value: unknown,
  schema: any,
  loc: string,
  issues: Issue[],
  rootSchema = schema,
  registry: SchemaRegistry = {},
): void {
  if (schema.anyOf) {
    if (!schema.anyOf.some((sub: any) => schemaMatches(value, sub, rootSchema, registry))) {
      issues.push({ path: file, message: `${loc} must match at least one allowed schema` });
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub: any) => schemaMatches(value, sub, rootSchema, registry)).length;
    if (matches !== 1) issues.push({ path: file, message: `${loc} must match exactly one allowed schema` });
  }
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, rootSchema, registry);
    if (!resolved) issues.push({ path: file, message: `${loc} has unsupported schema ref ${schema.$ref}` });
    else validateSchemaValue(file, value, resolved.schema, loc, issues, resolved.rootSchema, registry);
  }
  for (const sub of schema.allOf ?? []) validateSchemaValue(file, value, sub, loc, issues, rootSchema, registry);
  if (schema.if && schema.then && validateSchemaCondition(value, schema.if, rootSchema, registry)) validateSchemaValue(file, value, schema.then, loc, issues, rootSchema, registry);
  if (schema.const !== undefined && value !== schema.const) issues.push({ path: file, message: `${loc} must be ${schema.const}` });
  if (schema.enum && !schema.enum.includes(value)) issues.push({ path: file, message: `${loc} must be one of: ${schema.enum.join(", ")}` });
  const t = schema.type;
  if (!t && (schema.required || schema.properties)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be object` }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: file, message: `${loc}.${key} is required` });
    for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) if (key in obj) validateSchemaValue(file, obj[key], sub, `${loc}.${key}`, issues, rootSchema, registry);
  }
  if (t === "string") {
    if (typeof value !== "string") { issues.push({ path: file, message: `${loc} must be string` }); return; }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: file, message: `${loc} must not be empty` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ path: file, message: `${loc} must contain at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) issues.push({ path: file, message: `${loc} must match pattern ${schema.pattern}` });
    if (schema.format === "date-time") {
      const d = Date.parse(value);
      if (!dateTimeRe.test(value) || Number.isNaN(d)) issues.push({ path: file, message: `${loc} must be date-time` });
    }
    return;
  }
  if (t === "boolean" && typeof value !== "boolean") { issues.push({ path: file, message: `${loc} must be boolean` }); return; }
  if (t === "integer") {
    if (!Number.isInteger(value)) { issues.push({ path: file, message: `${loc} must be integer` }); return; }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) issues.push({ path: file, message: `${loc} must be at least ${schema.minimum}` });
    return;
  }
  if (t === "number" && typeof value !== "number") { issues.push({ path: file, message: `${loc} must be number` }); return; }
  if (t === "array") {
    if (!Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be array` }); return; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path: file, message: `${loc} must contain at least ${schema.minItems} item(s)` });
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) issues.push({ path: file, message: `${loc} must contain unique items` });
    if (schema.items) value.forEach((item, i) => validateSchemaValue(file, item, schema.items, `${loc}[${i}]`, issues, rootSchema, registry));
    return;
  }
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be object` }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: file, message: `${loc}.${key} is required` });
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj).filter((k) => !(k in props)).sort()) issues.push({ path: file, message: `${loc}.${key} is not allowed` });
    }
    for (const [key, sub] of Object.entries<any>(props)) if (key in obj) validateSchemaValue(file, obj[key], sub, `${loc}.${key}`, issues, rootSchema, registry);
  }
}
