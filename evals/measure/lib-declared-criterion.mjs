// Print the flow's declared acceptance-criterion id for a session. Kept in its own file
// rather than inlined: deriving it through nested shell quoting was itself a source of
// error, and guessing the id was one of the ten discovery failures being measured.
import fs from "node:fs";
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const found = [];
const walk = (node) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(walk);
  for (const [key, value] of Object.entries(node)) {
    if (key === "acceptance_criteria" && Array.isArray(value)) {
      for (const c of value) if (c && typeof c.id === "string") found.push(c.id);
    } else walk(value);
  }
};
walk(state);
process.stdout.write(found[0] ?? "");
