import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("models.json", () => {
  const modelsPath = resolve(process.cwd(), "models.json");
  let config: Record<string, unknown>;

  test("file exists", () => {
    expect(existsSync(modelsPath)).toBe(true);
  });

  test("valid JSON structure", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    config = JSON.parse(raw);
    expect(config).toHaveProperty("providers");
  });

  test("protolabs provider configured", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers).toHaveProperty("protolabs");
  });

  test("protolabs has correct base_url", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.protolabs.baseUrl).toBe("https://ai.proto-labs.ai/v1");
  });

  test("protolabs has api key", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.protolabs.apiKey).toBe("sk-dzCaTKg0S9Gq09lyOBBtwQ");
  });

  test("protolabs uses openai-completions api", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.protolabs.api).toBe("openai-completions");
  });

  test("protolabs/local model configured", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const models = parsed.providers.protolabs.models;
    expect(models).toBeArray();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("protolabs/local");
  });

  test("model has required fields", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const model = parsed.providers.protolabs.models[0];
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("input");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
    expect(model).toHaveProperty("cost");
  });

  test("compat settings present", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const compat = parsed.providers.protolabs.compat;
    expect(compat).toHaveProperty("supportsUsageInStreaming");
    expect(compat).toHaveProperty("maxTokensField");
    expect(compat.maxTokensField).toBe("max_tokens");
  });
});
