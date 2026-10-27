#!/usr/bin/env python3
"""Plot world-size evidence retrieval from a completed stress report.

Usage: python scripts/plot-world-stress.py [report.json] [output.svg]
Defaults to evaluation/world-stress-openrouter-result.json and
evaluation/world-stress-scaling.svg. Requires matplotlib.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "evaluation/world-stress-openrouter-result.json"
DEFAULT_OUTPUT = ROOT / "evaluation/world-stress-scaling.svg"
MODES = ("lexical", "hybrid")
BUDGETS = (20, 60, 120)
COLORS = {20: "#2878B5", 60: "#E07A18", 120: "#319455"}


def load_report(path: Path) -> dict:
    with path.open(encoding="utf-8") as source:
        report = json.load(source)
    status = report.get("status")
    allowed_status = status == "complete" or (
        status == "complete_with_context_rejections" and report.get("retrieval_complete") is True
    )
    if not allowed_status:
        raise ValueError(f"Report is not complete (status={report.get('status')!r})")
    if not isinstance(report.get("results"), list):
        raise ValueError("Report has no results array")
    # A top-level "complete" status can be written during initialization by an
    # older runner. Require the full planned matrix and companion evaluations.
    results = report["results"]
    if status == "complete_with_context_rejections" and any(
        int(row.get("provider_failures", 0)) != 0 for row in results
    ):
        raise ValueError("Retrieval report has provider failures")
    required = {
        (size, mode, limit)
        for size in (256, 1024, 4096)
        for mode in ("lexical", "hybrid")
        for limit in (20, 60, 120)
    }
    present = {
        (int(row.get("size", -1)), row.get("mode"), int(row.get("limit", -1)))
        for row in results
    }
    decision_present = any(row.get("mode") == "decision" for row in results)
    entity_cases = report.get("entity_cases")
    long_context = report.get("long_context")
    long_results = long_context.get("results", []) if isinstance(long_context, dict) else []
    if (
        not required.issubset(present)
        or len(results) < 19
        or not decision_present
        or not isinstance(entity_cases, list)
        or len(entity_cases) < 12
        or not isinstance(long_results, list)
        or len(long_results) < 7
    ):
        raise ValueError(
            "Report is incomplete: expected 18 lexical/hybrid conditions, a decision result, "
            "12 entity cases, and 7 long-context results"
        )
    return report


def metric(result: dict, name: str) -> float:
    summary = result.get("summary", {}).get("overall", {})
    if name == "path_coverage":
        total = summary.get("path_total", 0)
        return (100.0 * summary.get("path_covered", 0) / total) if total else float("nan")
    value = summary.get(name)
    return float(value) * 100.0 if value is not None else float("nan")


def plot(report_path: Path = DEFAULT_REPORT, output_path: Path = DEFAULT_OUTPUT) -> None:
    report = load_report(report_path)
    results = report["results"]
    worlds = sorted({int(row["size"]) for row in results})
    if not worlds:
        raise ValueError("Report contains no world-size results")

    # Retain absent runs as gaps; never synthesize points for missing conditions.
    lookup = {
        (int(row["size"]), row.get("mode"), int(row.get("limit", -1))): row
        for row in results
    }
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 5.0), sharex=True, sharey=True)
    fig.subplots_adjust(left=0.085, right=0.985, bottom=0.30, top=0.86, wspace=0.16)

    for ax, metric_name, title in (
        (axes[0], "support_recall", "Support recall"),
        (axes[1], "path_coverage", "Full path node coverage"),
    ):
        for mode in MODES:
            for budget in BUDGETS:
                ys = [
                    metric(lookup[(size, mode, budget)], metric_name)
                    if (size, mode, budget) in lookup
                    else float("nan")
                    for size in worlds
                ]
                ax.plot(
                    worlds,
                    ys,
                    color=COLORS[budget],
                    linestyle="-" if mode == "lexical" else "--",
                    marker="o" if mode == "lexical" else "s",
                    linewidth=1.8,
                    markersize=4.5,
                    label=f"{mode.title()} · {budget}",
                )
        # Decision reranking is available at the largest world and budget 20.
        decision = lookup.get((max(worlds), "decision", 20))
        if decision:
            value = metric(decision, metric_name)
            if value == value:
                ax.scatter(
                    [max(worlds)], [value], marker="*", s=105, color="#8A4FA3",
                    edgecolor="white", linewidth=0.5, zorder=5,
                )
        ax.set_title(title, fontsize=11, pad=8)
        ax.set_xscale("log", base=2)
        ax.set_xticks(worlds, [str(size) for size in worlds])
        ax.set_ylim(0, 100)
        ax.grid(axis="y", color="#D9DEE5", linewidth=0.7)
        ax.spines[["top", "right"]].set_visible(False)
        ax.set_xlabel("World size (original memories)", labelpad=6)
    axes[0].set_ylabel("Rate (%)")

    condition_handles = [
        Line2D([0], [0], color=COLORS[budget], linewidth=2, label=f"Budget {budget}")
        for budget in BUDGETS
    ] + [
        Line2D([0], [0], color="#4A5560", linestyle="-", marker="o", label="Lexical"),
        Line2D([0], [0], color="#4A5560", linestyle="--", marker="s", label="Hybrid"),
    ]
    if any(row.get("mode") == "decision" for row in results):
        condition_handles.append(Line2D([0], [0], color="#8A4FA3", marker="*", linestyle="None", label="Decision"))
    fig.legend(
        handles=condition_handles,
        loc="lower center",
        bbox_to_anchor=(0.5, 0.045),
        ncol=3,
        frameon=False,
        fontsize=8.5,
        columnspacing=1.6,
        handlelength=2.1,
    )
    fig.suptitle("Retrieval quality as the memory world grows", fontsize=13, y=0.97)
    fig.text(
        0.5,
        0.012,
        "Evidence retrieval; not causal answer accuracy",
        ha="center",
        va="bottom",
        fontsize=9,
        color="#39424E",
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, format="svg", facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    report_file = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPORT
    output_file = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUTPUT
    plot(report_file, output_file)
    print(f"Wrote {output_file}")
