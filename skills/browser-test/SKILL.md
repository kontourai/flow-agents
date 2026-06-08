---
name: "browser-test"
description: "Headless browser automation via Playwright — screenshots, accessibility checks, form filling, UI testing, DOM inspection."
---

# Browser Testing

Delegate browser automation and testing tasks to `tool-playwright` for real browser interaction — page loading, accessibility snapshots, form filling, screenshots, and user flow testing.

## Trigger Patterns

This skill activates when the user:

- Wants to load a URL and inspect the page
- Wants to test a user flow (click, type, navigate)
- Wants to check accessibility (ARIA roles, tab order, snapshots)
- Wants a screenshot for visual verification
- Wants to fill forms or interact with UI elements
- Mentions Playwright, browser testing, or DOM inspection
- Needs to debug frontend behavior in a live browser

## Workflow

### Step 1: CLARIFY TARGET
Identify what the user wants tested — a URL, a local dev server, a specific flow. If a local server is needed and not running, tell the user to start it first and provide the URL.

### Step 2: DELEGATE
Hand off to `tool-playwright` with a clear prompt describing:
- The URL to load
- What to inspect or test (accessibility, visual, flow)
- Any specific interactions (click X, fill Y, navigate to Z)

### Step 3: REPORT
Relay `tool-playwright`'s findings back to the user. Highlight:
- Accessibility issues found via snapshots
- Visual anomalies from screenshots
- Flow failures or unexpected behavior
- Suggested fixes if applicable

## NOT For

- General web search or fetching page content for research — use web search tools instead
- Scraping data from websites
- API testing — use curl or httpie directly

## Key Principles

- ALWAYS delegate to `tool-playwright` — do not attempt browser interaction directly
- Prefer accessibility snapshots (`browser_snapshot`) over screenshots for understanding page structure
- If the user provides a localhost URL, confirm the dev server is running before delegating
- Close the browser when done
