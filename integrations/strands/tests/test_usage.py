"""Tests for usage + cost: emit_usage, _extract_model_usage, _cost_for_model.

Covers the Python sink's share of the telemetry usage/cost surface, plus the
cross-runtime golden vectors (scripts/telemetry/pricing.golden.json) which must
price identically across bash / Python / the console-telemetry package.
"""

import json
import os
import tempfile
import unittest

from flow_agents_strands.telemetry import TelemetrySink, _cost_for_model, _normalize_tokens
from flow_agents_strands.hooks import _extract_model_usage

_HERE = os.path.dirname(os.path.abspath(__file__))
_GOLDEN = os.path.join(_HERE, "..", "..", "..", "scripts", "telemetry", "pricing.golden.json")


def _read_usage_event(sink_dir):
    """Return the single session.usage event written under sink_dir."""
    for root, _dirs, files in os.walk(sink_dir):
        for name in files:
            if name == "full.jsonl":
                with open(os.path.join(root, name), encoding="utf-8") as fh:
                    for line in fh:
                        rec = json.loads(line)
                        if rec.get("event_type") == "session.usage":
                            return rec["usage"]
    return None


class TestEmitUsage(unittest.TestCase):
    def test_emit_usage_writes_tokens_cost_version_and_by_model(self):
        d = tempfile.mkdtemp()
        sink = TelemetrySink(workspace=d)
        sink.emit_usage(
            model="claude-opus-4-8",
            input_tokens=1000,
            output_tokens=2000,
            cache_read_input_tokens=500000,
            by_model=[
                {"model": "claude-opus-4-8", "input_tokens": 1000, "output_tokens": 2000, "cache_read_input_tokens": 500000}
            ],
        )
        usage = _read_usage_event(d)
        self.assertIsNotNone(usage)
        self.assertEqual(usage["input_tokens"], 1000)
        self.assertEqual(usage["output_tokens"], 2000)
        self.assertEqual(usage["cache_read_input_tokens"], 500000)
        self.assertEqual(usage["pricing_version"], "2026-06-28")
        # opus: (1000*5 + 2000*25 + 500000*5*0.1)/1e6 = 0.305
        self.assertAlmostEqual(usage["estimated_cost_usd"], 0.305, places=6)
        self.assertEqual(usage["by_model"][0]["model"], "claude-opus-4-8")

    def test_emit_usage_multi_model_sums_and_prices_each(self):
        d = tempfile.mkdtemp()
        sink = TelemetrySink(workspace=d)
        sink.emit_usage(
            input_tokens=0,
            output_tokens=2000,
            by_model=[
                {"model": "claude-opus-4-8", "output_tokens": 1000},
                {"model": "claude-haiku-4-5", "output_tokens": 1000},
            ],
        )
        usage = _read_usage_event(d)
        costs = {m["model"]: m["estimated_cost_usd"] for m in usage["by_model"]}
        self.assertAlmostEqual(costs["claude-opus-4-8"], 0.025, places=6)  # 1000*25/1e6
        self.assertAlmostEqual(costs["claude-haiku-4-5"], 0.005, places=6)  # 1000*5/1e6
        self.assertAlmostEqual(usage["estimated_cost_usd"], 0.03, places=6)


class TestExtractModelUsage(unittest.TestCase):
    class _Ev:
        pass

    def _ev(self, **kw):
        e = self._Ev()
        for k, v in kw.items():
            setattr(e, k, v)
        return e

    def test_extract_from_object_with_usage_and_model(self):
        e = self._ev(model="claude-opus-4-8", usage={"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 30})
        got = _extract_model_usage(e)
        self.assertEqual(got, {"model": "claude-opus-4-8", "input": 10, "output": 20, "cache_creation": 0, "cache_read": 30})

    def test_extract_from_dict_and_camelcase(self):
        e = self._ev(usage={"inputTokens": 5, "outputTokens": 6}, model_id="claude-haiku-4-5")
        got = _extract_model_usage(e)
        self.assertEqual(got["model"], "claude-haiku-4-5")
        self.assertEqual(got["input"], 5)
        self.assertEqual(got["output"], 6)

    def test_extract_from_nested_response(self):
        e = self._ev(response={"model": "claude-fable-5", "usage": {"output_tokens": 100}})
        got = _extract_model_usage(e)
        self.assertEqual(got["model"], "claude-fable-5")
        self.assertEqual(got["output"], 100)

    def test_extract_returns_none_when_no_usage(self):
        self.assertIsNone(_extract_model_usage(self._ev(model="x")))

    def test_extract_returns_none_when_all_zero(self):
        self.assertIsNone(_extract_model_usage(self._ev(model="x", usage={"input_tokens": 0, "output_tokens": 0})))


class TestGoldenVectors(unittest.TestCase):
    def test_cross_runtime_golden_vectors(self):
        with open(_GOLDEN, encoding="utf-8") as fh:
            golden = json.load(fh)
        for case in golden["cases"]:
            t = case["tokens"]
            tokens = _normalize_tokens({
                "input_tokens": t["input"],
                "output_tokens": t["output"],
                "cache_creation_input_tokens": t["cache_creation"],
                "cache_read_input_tokens": t["cache_read"],
            })
            cost = _cost_for_model(case["model"], tokens)
            self.assertAlmostEqual(
                cost, case["expected_cost_usd"], places=6,
                msg=f"golden '{case['name']}' ({case['model']}): expected {case['expected_cost_usd']}, got {cost}",
            )


if __name__ == "__main__":
    unittest.main()
