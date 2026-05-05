import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import { TEST_API_URL } from "../lib";
import { idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "deprecation",
    concurrency: 10,
    credits: 1000,
  });
}, 10000);

describe("Deprecation warnings on legacy endpoints", () => {
  it("POST /v1/llmstxt enqueues with Deprecation header and warning in body", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/llmstxt")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ url: "https://firecrawl.dev" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers["deprecation"]).toBe("true");
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning).toMatch(/llmstxt/i);
    expect(res.body.warning).toMatch(/deprecated/i);
    expect(res.body.replacement).toBeUndefined();
  }, 30000);

  it("GET /v1/llmstxt/:jobId still emits warning on 404", async () => {
    const res = await request(TEST_API_URL)
      .get(`/v1/llmstxt/${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(res.statusCode).toBe(404);
    expect(res.headers["deprecation"]).toBe("true");
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning).toMatch(/deprecated/i);
  }, 30000);

  it("POST /v1/deep-research returns warning pointing to /v2/search", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/deep-research")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({
        query: "what is firecrawl",
        maxDepth: 1,
        maxUrls: 1,
        timeLimit: 60,
      });

    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe("true");
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning).toMatch(/deep-research/i);
    expect(res.body.replacement).toBe("/v2/search");
  }, 30000);

  it("non-deprecated endpoints do not emit Deprecation header or warning", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/scrape")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ url: "https://firecrawl.dev" });

    expect(res.headers["deprecation"]).toBeUndefined();
    if (res.body && typeof res.body === "object") {
      expect(res.body.replacement).toBeUndefined();
    }
  }, 60000);
});
