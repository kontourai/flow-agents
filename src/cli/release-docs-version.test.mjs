import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const architecture = "docs/developer-architecture.md";

test("architecture identifies the source package version on one Release Please update line", () => {
  const { name, version } = JSON.parse(read("package.json"));
  const lines = read(architecture).split(/\r?\n/).filter((line) =>
    line.includes("x-release-please-version"));
  assert.equal(lines.length, 1, "keep exactly one inline package identity marker");
  assert.ok(lines[0].includes(`\`${name}\``), "identify the package whose version is bound");
  assert.ok(lines[0].includes(`version \`${version}\``), "architecture must match package.json");
  const versions = lines[0].match(/\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/g);
  assert.deepEqual(versions, [version], "the generic updater replaces the first semver on its line");
});

test("normal Release Please registers the architecture as a generic extra file", () => {
  const config = JSON.parse(read("release-please-config.json"));
  const files = config.packages["."]["extra-files"] ?? config["extra-files"] ?? [];
  const matches = files.filter((file) => typeof file === "string"
    ? file === architecture
    : file.type === "generic" && file.path === architecture);
  assert.equal(matches.length, 1, "the release updater must actually receive the marked document");
});

test("architecture freshness still covers package changes beyond the version binding", () => {
  const corpus = JSON.parse(read("corpus.json"));
  const document = corpus.documents.find((entry) => entry.source === architecture);
  assert.ok(document?.covers?.includes("package.json"), "retain package.json freshness coverage");
});
