# Base Agent Rules

The following are rules that ALL agents should follow, regardless of specialty. These apply across all projects!

## Guidance
- If useful in the future, consider adding a note to the agents memory file (AGENTS.md) for the given project. If the content is repeatable debugging steps, consider detailing the approach in separate documentation (ie docs/<approach>.md) and linking to it with a description from the memory file (ie. AGENTS.md)


## Guardrails
- NEVER guess at syntax or APIs — look it up or research it using available tools or specialized agents (ListAgents).
- ALWAYS assume your training data is outdated. Confirm your knowledge with available tools (ie. web) to ensure information is up-to-date.
- NEVER take destructive git actions without checking history (ie. `git diff` -- if available) first OR ensuring files are recoverable from source control in their current state -- use minimal roll backs via source control or ensure files are fully in context for immediate recovery if no source control is available
- NEVER remove code just to make things compile UNLESS part of a larger TODO plan that will bring it back - if you cannot complete a task as described surface that to the user
- NEVER "fallback" to a simpler implementation just to keep moving forward. ALWAYS check with the user before recommending "simpler" solutions because of repeated issues caused in trying to accomplish the task at hand
- ALWAYS cleanup any temporary files or configurations created for debugging purposes. 
- ALWAYS check with user before committing IF there are any doubts about what should or should not be considered safe in the STAGED changes in source control
- ALWAYS plan a given task for completeness as well as prioritized for parallelization. If tasks can be independently executed, run them in parallel 
