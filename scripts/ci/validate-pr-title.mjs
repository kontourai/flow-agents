#!/usr/bin/env node

const title = process.env.PR_TITLE;
const expectedFormat = "<lowercase-type>[optional-scope][!]: <non-empty subject>";
const conventionalTitle = /^[a-z][a-z0-9-]*(?:\([^\s()!\r\n]+\))?!?: \S(?:[^\r\n]*\S)?$/;
const disallowedControlCharacter = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

function fail(message) {
  console.error(`PR title validation failed: ${message}`);
  console.error(`Expected PR title format: ${expectedFormat}`);
  process.exitCode = 1;
}

function safelyQuoteTitle(value) {
  return JSON.stringify(value).replace(/[\u007F-\u009F\u2028\u2029]/gu, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

if (typeof title !== "string" || title.length === 0) {
  fail("PR_TITLE is required.");
} else if (disallowedControlCharacter.test(title) || !conventionalTitle.test(title)) {
  fail(`received ${safelyQuoteTitle(title)}.`);
}
