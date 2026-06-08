# ADR 0003: Flow Agents Coordinates Kits And Adapters

Flow Agents will not own the builder, or knowledge workflows as core behavior. Those out-of-the-box behaviors will be extracted into normal Flow Kits that use the same manifest, Flow Definition, skill, doc, provider, and eval contracts as third-party kits. Flow Agents owns kit validation, installation, runtime adapter selection, provider wiring, status/control commands, and runtime-specific export; Runtime Adapters own target-specific integration for local agent runtimes and API/framework agents.

**Status**: Accepted

**Considered Options**: Keeping built-in workflows inside Flow Agents core would make the kit model less real and force custom users into a second-class extension path. Treating every adapter as built into Flow Agents would make local agent runtimes, LangGraph, Strands, CrewAI, VoltAgent, and future API frameworks all pay for each other's dependencies and release cadence. Separate adapter packages can come after the internal interface is proven, but the architecture should assume adapters are independently selectable.

**Consequences**: The Builder Kit is the first proof point and should be self-validated before Knowledge receives the same depth. Knowledge can remain a future kit target until the builder workflow proves the kit, adapter, and install contracts.
