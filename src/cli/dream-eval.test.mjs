// Runs the brief-ranking eval (kits/knowledge/evals/brief-ranking, #671 AC6) under the unit-test build.
// It cannot be a kit-declared eval: those run from an isolated kit install, and the brief renders claims
// through the package's own `presentMemoryClaims`, which needs `npm run build`.
import "../../kits/knowledge/evals/brief-ranking/suite.test.js";
