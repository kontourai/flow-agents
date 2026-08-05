export default {
  name: "reference-provider-adapter",
  capabilities: { supported: ["structured-output", "exact-excerpts", "task-specifications", "usage", "warnings"] },
  async extract() {
    return {
      proposals: [{ fieldPath: "status", candidateValue: "Paused", confidence: 0.98,
        provenance: { excerpt: "Paused", locator: "reference-provider-adapter" }, extractor: "reference-provider-adapter" }],
      raw: { response: "reference provider result", model: "reference-provider-model", tokensUsed: 42 },
    };
  },
};
