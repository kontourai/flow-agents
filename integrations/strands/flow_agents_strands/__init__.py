"""
flow_agents_strands — Flow Agents framework adapter for AWS Strands Agents.

Provides FlowAgentsHooks, a HookProvider (duck-typed so strands-agents is
optional at import time) that wires Flow Agents' canonical telemetry events,
policy gates, and workflow-steering context into the Strands hook surface.

Importable without strands-agents installed:

    from flow_agents_strands import FlowAgentsHooks
    hooks = FlowAgentsHooks()          # no strands needed yet
    ctx   = hooks.steering_context()   # load steering context anywhere
"""

from .hooks import FlowAgentsHooks
from .telemetry import STRANDS_TO_CANONICAL, TelemetrySink
from .policy import PolicyGate
from .steering import SteeringContext

__all__ = [
    "FlowAgentsHooks",
    "STRANDS_TO_CANONICAL",
    "TelemetrySink",
    "PolicyGate",
    "SteeringContext",
]
__version__ = "0.0.1"
