import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Execute the pinned provider schema instead of maintaining another file shape.
// Unsupported future schema keywords fail closed instead of being ignored.
const keywords = new Set(['$schema','type','properties','required','additionalProperties',
  'const','enum','minimum','maximum','exclusiveMinimum','exclusiveMaximum',
  'minLength','maxLength','pattern','format','default','minItems','maxItems','items','oneOf']);
function compile(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) ||
      Object.keys(schema).some(key => !keywords.has(key))) throw new Error('Unsupported artifact schema.');
  // The provider pattern defines UUID validation; do not duplicate it.
  if (schema.format && (schema.format !== 'uuid' || !schema.pattern))
    throw new Error('Unsupported artifact format.');
  // The provider uses a disjoint union to retain the legacy file limit while
  // permitting only explicit source_video at its own bound. Exactly one branch
  // must match; unknown keywords and ambiguous unions remain fail closed.
  if ('oneOf' in schema && (!Array.isArray(schema.oneOf) || !schema.oneOf.length || schema.oneOf.length > 16))
    throw new Error('Unsupported artifact union.');
  const alternatives = schema.oneOf?.map(compile);
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key,compile(child)]));
  const item = schema.items ? compile(schema.items) : null;
  const pattern = schema.pattern ? new RegExp(schema.pattern) : null;
  return value => {
    if ('const' in schema && value !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (alternatives && alternatives.filter(matches => matches(value)).length !== 1) return false;
    switch (schema.type) {
      case 'object':
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if ((schema.required ?? []).some(key => !Object.hasOwn(value,key))) return false;
        return Object.keys(value).every(key => Object.hasOwn(properties,key) ? properties[key](value[key]) : schema.additionalProperties !== false);
      case 'array':
        return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) &&
          (schema.maxItems === undefined || value.length <= schema.maxItems) && (!item || value.every(item));
      case 'string': {
        if (typeof value !== 'string') return false;
        // Avoid another character array for large strings.
        let length = 0; for (const char of value) { length++; if (schema.maxLength !== undefined && length > schema.maxLength) return false; }
        return (schema.minLength === undefined || length >= schema.minLength) && (!pattern || pattern.test(value));
      }
      case 'integer':
      case 'number':
        return typeof value === 'number' && Number.isFinite(value) &&
          (schema.type !== 'integer' || Number.isSafeInteger(value)) &&
          (schema.minimum === undefined || value >= schema.minimum) &&
          (schema.maximum === undefined || value <= schema.maximum) &&
          (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) &&
          (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum);
      case undefined:
        if (alternatives) return true;
        throw new Error('Unsupported artifact type.');
      default: throw new Error('Unsupported artifact type.');
    }
  };
}
let cached;
export function remakeArtifactContract() {
  if (cached) return cached;
  const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../contracts');
  const bytes=fs.readFileSync(path.join(dir,'remake-artifact-v1.json'));
  const expected=fs.readFileSync(path.join(dir,'remake-artifact-v1.sha256'),'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expected) || crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Artifact snapshot integrity failed.');
  const artifact=JSON.parse(bytes);
  if (artifact.schema_version !== 'kabo.remake-artifact-contract.v1') throw new Error('Unsupported artifact contract.');
  cached={ policy:artifact['x-kabo-policy'], visible:compile(artifact.output_schema), body:compile(artifact.host_body_schema) };
  return cached;
}
