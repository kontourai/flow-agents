#!/usr/bin/env python3
"""
example.py — Intended usage of FlowAgentsHooks with a real Strands Agent.

Guarded by try/except ImportError so it degrades gracefully when
strands-agents is not installed (e.g. in CI or unit-test environments).

Run this only when:
  1. strands-agents is installed: pip install "flow-agents-strands[strands]"
  2. AWS credentials are configured for Bedrock (or swap to a different model)
"""

from flow_agents_strands import FlowAgentsHooks

# Step 1: Build hooks — no strands import required
hooks = FlowAgentsHooks(
    workspace=".",           # root of your project (reads .flow-agents/)
    agent_name="example-agent",
)

# Step 2: Load steering context at agent construction time.
# This is the documented spike workaround for the system-prompt seam:
# BeforeInvocationEvent does not expose a mutable system_prompt in Strands,
# so we snapshot workflow state once and prepend it to the system prompt.
# See README.md § Limitations for details.
base_system_prompt = (
    "You are a helpful assistant. "
    "Follow the Flow Agents workflow discipline."
)
steering = hooks.steering_context()
system_prompt = base_system_prompt + steering

print("=== Flow Agents Strands Example ===")
print(f"Steering context ({len(steering)} chars):")
print(steering or "(none — no active workflow state found)")
print()

try:
    from strands import Agent  # type: ignore[import]
    from strands.models import BedrockModel  # type: ignore[import]

    model = BedrockModel(
        model_id="anthropic.claude-3-5-sonnet-20241022-v2:0",
        region_name="us-east-1",
    )

    agent = Agent(
        model=model,
        system_prompt=system_prompt,
        hooks=[hooks],
    )

    print("Agent created. Running a simple task...")
    result = agent("List the Python files in the current directory.")
    print("Result:", result)
    print()
    print("Telemetry written to .flow-agents/.telemetry/full.jsonl")

except ImportError:
    print(
        "strands-agents is not installed.\n"
        "Install it to run against a live agent:\n"
        "  pip install 'flow-agents-strands[strands]'\n"
        "\n"
        "The hooks and telemetry modules work without strands-agents installed.\n"
        "Run the unit tests with:\n"
        "  python3 -m unittest discover"
    )
except Exception as exc:
    print(f"Agent run failed (likely missing AWS credentials): {exc}")
    print(
        "\nThis example requires AWS credentials configured for Bedrock.\n"
        "The hooks + telemetry code ran successfully up to the Agent() call."
    )
