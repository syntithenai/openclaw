import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Compact tool schema to reduce token usage in LLM inference calls.
 * This strips optional parameters and shortens descriptions.
 */
export function compactToolSchema(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema) {
    return tool;
  }

  const compactedSchema = compactSchemaObject(schema);

  return {
    ...tool,
    description: compactDescription(tool.description ?? ""),
    parameters: compactedSchema,
  };
}

// Important parameter aliases that should never be removed even if optional
// These are critical for Claude Code compatibility and model training data
const PRESERVED_ALIASES = new Set(["file_path", "old_string", "new_string"]);

/**
 * Helper to compact a schema object recursively.
 * Removes optional properties and simplifies descriptions.
 */
function compactSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];

  // Keep type, required fields
  if ("type" in schema) {
    compacted.type = schema.type;
  }

  // Only include required properties and important aliases
  if ("properties" in schema && typeof schema.properties === "object" && schema.properties) {
    const properties = schema.properties as Record<string, unknown>;
    const compactedProperties: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      // Include if it's required, no required fields exist, or it's a preserved alias
      const shouldInclude =
        required.length === 0 || required.includes(key) || PRESERVED_ALIASES.has(key);

      if (shouldInclude) {
        if (value && typeof value === "object") {
          const propSchema = { ...(value as Record<string, unknown>) };

          // Compact property description
          if ("description" in propSchema && typeof propSchema.description === "string") {
            propSchema.description = compactDescription(propSchema.description);
          }

          // Recursively compact nested schemas
          if ("properties" in propSchema || "items" in propSchema) {
            compactedProperties[key] = compactSchemaObject(propSchema);
          } else {
            compactedProperties[key] = propSchema;
          }
        } else {
          compactedProperties[key] = value;
        }
      }
    }

    if (Object.keys(compactedProperties).length > 0) {
      compacted.properties = compactedProperties;
    }
  }

  if ((schema.type === "object" || "properties" in schema) && !("properties" in compacted)) {
    compacted.properties = {};
  }

  // Keep required field
  if (required.length > 0) {
    compacted.required = required;
  }

  // Handle arrays
  if ("items" in schema && schema.items) {
    if (typeof schema.items === "object") {
      compacted.items = compactSchemaObject(schema.items as Record<string, unknown>);
    } else {
      compacted.items = schema.items;
    }
  }

  // Handle enums (keep them for valid values)
  if ("enum" in schema) {
    compacted.enum = schema.enum;
  }

  // Handle anyOf, oneOf (keep structure but compact nested schemas)
  for (const key of ["anyOf", "oneOf"] as const) {
    if (key in schema && Array.isArray(schema[key])) {
      compacted[key] = (schema[key] as unknown[]).map((item) => {
        if (item && typeof item === "object") {
          return compactSchemaObject(item as Record<string, unknown>);
        }
        return item;
      });
    }
  }

  return compacted;
}

/**
 * Compact a description string by:
 * - Taking only the first sentence
 * - Removing unnecessary words
 * - Limiting length
 */
function compactDescription(desc: string): string {
  if (!desc || desc.length === 0) {
    return "";
  }

  // Take first sentence (up to . or newline)
  const firstSentence = desc.split(/[.\n]/)[0]?.trim() || "";

  // Limit to 50 characters max
  if (firstSentence.length <= 50) {
    return firstSentence;
  }

  // Truncate and add ellipsis
  return firstSentence.substring(0, 47) + "...";
}

/**
 * Determine if a tool should be compacted based on the config.
 *
 * @param toolName The name of the tool
 * @param config The compactSchema configuration (boolean, string, or string[])
 * @returns true if the tool should be compacted
 */
export function shouldCompactTool(
  toolName: string,
  config: boolean | string | string[] | undefined,
): boolean {
  if (!config) {
    return false;
  }

  if (typeof config === "boolean") {
    return config;
  }

  if (typeof config === "string") {
    return config === toolName;
  }

  if (Array.isArray(config)) {
    return config.includes(toolName);
  }

  return false;
}

/**
 * Apply compaction to a list of tools based on the config.
 *
 * @param tools Array of tools
 * @param config The compactSchema configuration
 * @returns Array of tools with compaction applied where configured
 */
export function applyToolSchemaCompaction(
  tools: AnyAgentTool[],
  config: boolean | string | string[] | undefined,
): AnyAgentTool[] {
  if (!config) {
    return tools;
  }

  return tools.map((tool) => {
    if (shouldCompactTool(tool.name, config)) {
      return compactToolSchema(tool);
    }
    return tool;
  });
}
