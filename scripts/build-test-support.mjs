import fs from "node:fs";
import path from "node:path";

const workflowFile = path.resolve("build/src/cli/workflow.js");
const testSupportFile = path.resolve("build/src/cli/workflow.test-support.js");
const workflow = fs.readFileSync(workflowFile, "utf8");
if (!workflow.includes("async function publishDeliveryFromPublicWorkflow(")) {
  throw new Error("workflow test support could not find the private delivery publication entrypoint");
}
if (workflow.includes("publishDeliveryFromPublicWorkflowWithAuthorityForTest")) {
  throw new Error("workflow production build unexpectedly exports the test authority seam");
}
const testSupport = `

// Generated test-only entrypoint. This file is excluded from the npm package.
export function publishDeliveryFromPublicWorkflowWithAuthorityForTest(sessionDir, authorizationFile, authority) {
  return publishDeliveryFromPublicWorkflow(sessionDir, false, "provisional", authorizationFile, authority);
}

export function publishTerminalDeliveryFromPublicWorkflowWithAuthorityForTest(sessionDir, authority) {
  return publishDeliveryFromPublicWorkflow(sessionDir, false, "terminal", undefined, authority);
}
`;

fs.writeFileSync(testSupportFile, `${workflow}${testSupport}`);
