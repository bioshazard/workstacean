import { describe, test, expect } from "bun:test";
import OpenAI from "openai";

describe("Local LLM endpoint", () => {
  test("tell me a tiny joke — gets a real LLM response", async () => {
    const client = new OpenAI({
      baseURL: "https://bios-pc.cloud.bios.dev:8443/v1",
      apiKey: "sk-dummy",
    });

    const response = await client.chat.completions.create({
      model: "default",
      messages: [{ role: "user", content: "tell me a tiny joke" }],
      max_tokens: 256,
    });

    const text = response.choices[0]?.message?.content ?? "";
    expect(text.length).toBeGreaterThan(5);
    console.log("LLM replied:", text);
  }, 60_000);
});
