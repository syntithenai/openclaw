import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  applyToolSchemaCompaction,
  compactToolSchema,
  shouldCompactTool,
} from "./tool-schema-compaction.js";

describe("shouldCompactTool", () => {
  it("returns false when config is undefined", () => {
    expect(shouldCompactTool("read", undefined)).toBe(false);
  });

  it("returns true when config is true (all tools)", () => {
    expect(shouldCompactTool("read", true)).toBe(true);
    expect(shouldCompactTool("write", true)).toBe(true);
  });

  it("returns false when config is false", () => {
    expect(shouldCompactTool("read", false)).toBe(false);
  });

  it("returns true when tool name matches string config", () => {
    expect(shouldCompactTool("read", "read")).toBe(true);
    expect(shouldCompactTool("write", "read")).toBe(false);
  });

  it("returns true when tool name is in array config", () => {
    expect(shouldCompactTool("read", ["read", "write"])).toBe(true);
    expect(shouldCompactTool("write", ["read", "write"])).toBe(true);
    expect(shouldCompactTool("exec", ["read", "write"])).toBe(false);
  });
});

describe("compactToolSchema", () => {
  it("compacts tool description to first sentence", () => {
    const tool = {
      name: "test",
      label: "test",
      description: "This is the first sentence. This is the second sentence.",
      parameters: { type: "object" },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AgentTool;

    const result = compactToolSchema(tool);
    expect(result.description).toBe("This is the first sentence");
    expect(result.parameters).toEqual({ type: "object", properties: {} });
  });

  it("truncates long descriptions to 50 characters", () => {
    const tool = {
      name: "test",
      label: "test",
      description: "This is a very long description that exceeds fifty characters in length",
      parameters: { type: "object" },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AgentTool;

    const result = compactToolSchema(tool);
    expect(result.description?.length).toBeLessThanOrEqual(50);
    expect(result.description).toContain("...");
  });

  it("removes optional parameters (keeps only required)", () => {
    const tool = {
      name: "test",
      label: "test",
      description: "Test tool",
      parameters: {
        type: "object",
        properties: {
          required1: { type: "string", description: "Required param" },
          optional1: { type: "string", description: "Optional param" },
          required2: { type: "number", description: "Another required" },
        },
        required: ["required1", "required2"],
      },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AgentTool;

    const result = compactToolSchema(tool);
    const params = result.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(["required1", "required2"]);
    expect(properties.optional1).toBeUndefined();
  });

  it("keeps all properties when no required field is specified", () => {
    const tool = {
      name: "test",
      label: "test",
      description: "Test tool",
      parameters: {
        type: "object",
        properties: {
          param1: { type: "string" },
          param2: { type: "number" },
        },
      },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AgentTool;

    const result = compactToolSchema(tool);
    const params = result.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(["param1", "param2"]);
  });

  it("preserves enum values", () => {
    const tool = {
      name: "test",
      label: "test",
      description: "Test tool",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "write", "delete"],
          },
        },
        required: ["action"],
      },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AgentTool;

    const result = compactToolSchema(tool);
    const params = result.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;
    const action = properties.action as Record<string, unknown>;

    expect(action.enum).toEqual(["read", "write", "delete"]);
  });
});

describe("applyToolSchemaCompaction", () => {
  it("returns tools unchanged when config is undefined", () => {
    const tools = [
      {
        name: "read",
        label: "read",
        description: "Read a file",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as unknown as AgentTool[];

    const result = applyToolSchemaCompaction(tools, undefined);
    expect(result).toEqual(tools);
  });

  it("compacts all tools when config is true", () => {
    const tools = [
      {
        name: "read",
        label: "read",
        description: "Read a file. Additional details.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            optional: { type: "string" },
          },
          required: ["path"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as unknown as AgentTool[];

    const result = applyToolSchemaCompaction(tools, true);

    expect(result[0]?.description).toBe("Read a file");

    const readParams = result[0]?.parameters as Record<string, unknown>;
    const readProps = readParams.properties as Record<string, unknown>;
    expect(Object.keys(readProps)).toEqual(["path"]);
  });

  it("compacts only specified tool when config is string", () => {
    const tools = [
      {
        name: "read",
        label: "read",
        description: "Read a file. Additional details.",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
      {
        name: "write",
        label: "write",
        description: "Write a file. More info.",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as unknown as AgentTool[];

    const result = applyToolSchemaCompaction(tools, "read");

    expect(result[0]?.description).toBe("Read a file");
    expect(result[1]?.description).toBe("Write a file. More info.");
  });

  it("compacts only specified tools when config is array", () => {
    const tools = [
      {
        name: "read",
        label: "read",
        description: "Read a file. Additional.",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
      {
        name: "write",
        label: "write",
        description: "Write a file. More.",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
      {
        name: "exec",
        label: "exec",
        description: "Execute a command. Extra.",
        parameters: { type: "object" },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as unknown as AgentTool[];

    const result = applyToolSchemaCompaction(tools, ["read", "write"]);

    expect(result[0]?.description).toBe("Read a file");
    expect(result[1]?.description).toBe("Write a file");
    expect(result[2]?.description).toBe("Execute a command. Extra.");
  });

  it("preserves Claude Code parameter aliases (file_path, old_string, new_string)", () => {
    const tools = [
      {
        name: "read",
        label: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            file_path: { type: "string", description: "File path alias" },
          },
          required: ["path"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
      {
        name: "edit",
        label: "edit",
        description: "Edit a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            file_path: { type: "string", description: "File path alias" },
            oldText: { type: "string", description: "Old text" },
            old_string: { type: "string", description: "Old text alias" },
            newText: { type: "string", description: "New text" },
            new_string: { type: "string", description: "New text alias" },
          },
          required: ["path", "oldText", "newText"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as unknown as AgentTool[];

    const result = applyToolSchemaCompaction(tools, true);

    // Check read tool preserves file_path alias
    const readParams = result[0]?.parameters as Record<string, unknown>;
    const readProps = readParams.properties as Record<string, unknown>;
    expect(Object.keys(readProps).toSorted()).toEqual(["file_path", "path"]);

    // Check edit tool preserves all aliases
    const editParams = result[1]?.parameters as Record<string, unknown>;
    const editProps = editParams.properties as Record<string, unknown>;
    expect(Object.keys(editProps).toSorted()).toEqual([
      "file_path",
      "newText",
      "new_string",
      "oldText",
      "old_string",
      "path",
    ]);
  });
});
