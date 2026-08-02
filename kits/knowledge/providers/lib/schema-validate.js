/**
 * Minimal, dependency-free JSON-Schema validator.
 *
 * Supports exactly the draft-07 subset used by the Knowledge Kit graph schemas
 * (schemas/knowledge/*.schema.json): type, required, properties,
 * additionalProperties:false, enum, const, items, minLength, minItems, integer,
 * dependencies, oneOf, not, bounded strings/arrays/numbers, and local `$ref`
 * into `#/$defs/*`. It is intentionally NOT a general validator
 * — it exists so health reports and conformance tests can assert schema validity
 * without pulling an external dependency (the same zero-dep discipline the
 * decision-registry validator follows).
 *
 * @module providers/lib/schema-validate
 */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object") return typeOf(value) === "object";
  if (type === "array") return Array.isArray(value);
  return typeOf(value) === type;
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref (only local #/ refs): ${ref}`);
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const part of parts) {
    node = node && node[part];
  }
  if (!node) throw new Error(`Unresolved $ref: ${ref}`);
  return node;
}

function validateCombinators(value, schema, root, pathStr, errors) {
  if (schema.not) {
    const nestedErrors = [];
    validateNode(value, schema.not, root, pathStr, nestedErrors);
    if (nestedErrors.length === 0) errors.push(`${pathStr}: matched disallowed schema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      const nestedErrors = [];
      validateNode(value, candidate, root, pathStr, nestedErrors);
      return nestedErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${pathStr}: expected exactly one oneOf branch, got ${matches}`);
  }
}

function validateLiteralAndType(value, schema, pathStr, errors) {
  if ("const" in schema) {
    if (value !== schema.const) {
      errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${pathStr}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join("|")}, got ${typeOf(value)}`);
      return false;
    }
  }
  return true;
}

function validateScalar(value, schema, pathStr, errors) {
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${pathStr}: string longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${pathStr}: number smaller than minimum ${schema.minimum}`);
  }
}

function validateArray(value, schema, root, pathStr, errors) {
  if (!Array.isArray(value)) return;
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${pathStr}: array shorter than minItems ${schema.minItems}`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${pathStr}: array longer than maxItems ${schema.maxItems}`);
  }
  if (schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items, root, `${pathStr}[${i}]`, errors));
  }
}

function validateObject(value, schema, root, pathStr, errors) {
  if (typeOf(value) !== "object") return;
  const props = schema.properties || {};
  for (const req of schema.required || []) {
    if (!(req in value)) errors.push(`${pathStr}: missing required property '${req}'`);
  }
  for (const [key, dependencies] of Object.entries(schema.dependencies || {})) {
    if (!(key in value) || !Array.isArray(dependencies)) continue;
    for (const dependency of dependencies) {
      if (!(dependency in value)) {
        errors.push(`${pathStr}: property '${key}' requires '${dependency}'`);
      }
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) errors.push(`${pathStr}: unexpected property '${key}'`);
    }
  }
  for (const [key, propSchema] of Object.entries(props)) {
    if (key in value) {
      validateNode(value[key], propSchema, root, `${pathStr}/${key}`, errors);
    }
  }
}

function validateNode(value, schema, root, pathStr, errors) {
  if (schema.$ref) {
    validateNode(value, resolveRef(schema.$ref, root), root, pathStr, errors);
    return;
  }
  validateCombinators(value, schema, root, pathStr, errors);
  if (!validateLiteralAndType(value, schema, pathStr, errors)) return;
  validateScalar(value, schema, pathStr, errors);
  validateArray(value, schema, root, pathStr, errors);
  validateObject(value, schema, root, pathStr, errors);
}

/**
 * Validate `value` against `schema`.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Assert validity, throwing a descriptive error when invalid. Handy in tests.
 */
export function assertValid(value, schema, label = "value") {
  const { valid, errors } = validate(value, schema);
  if (!valid) {
    const err = new Error(`${label} failed schema validation:\n  ${errors.join("\n  ")}`);
    err.code = "SCHEMA_INVALID";
    err.errors = errors;
    throw err;
  }
}
