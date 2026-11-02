"""Score local ASR output with JiWER. Reference text is used only after decoding."""
import hashlib
import importlib.metadata
import json
import random
import statistics
import sys
import unicodedata
from pathlib import Path

import jiwer


def normalize(text):
    # Explicit, language-independent literal metric; numbers stay as written.
    text = "".join(" " if unicodedata.category(c).startswith("P") else c for c in text)
    return " ".join(text.lower().split())


def counts(reference, hypothesis):
    ref, hyp = normalize(reference), normalize(hypothesis)
    words = jiwer.process_words(ref, hyp)
    chars = jiwer.process_characters(ref, hyp)
    return dict(wer=words.wer, cer=chars.cer, referenceWords=len(ref.split()),
                substitutions=words.substitutions, deletions=words.deletions,
                insertions=words.insertions, hits=words.hits,
                errors=words.substitutions + words.deletions + words.insertions,
                alignment=jiwer.visualize_alignment(words))


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    at = (len(values) - 1) * p
    low = int(at)
    return values[low] + (values[min(low + 1, len(values) - 1)] - values[low]) * (at - low)


def aggregate(rows):
    result = dict(pairs=len(rows))
    for variant in ["baseline", "candidate"]:
        values = [r["variants"][variant] for r in rows]
        denominator = sum(x["score"]["referenceWords"] for x in values)
        errors = sum(x["score"]["errors"] for x in values)
        result[variant] = dict(
            wer=errors / denominator if denominator else None,
            errors=errors, referenceWords=denominator,
            substitutions=sum(x["score"]["substitutions"] for x in values),
            deletions=sum(x["score"]["deletions"] for x in values),
            insertions=sum(x["score"]["insertions"] for x in values),
            retries=sum(x["retries"] for x in values),
            flaggedWindows=sum(a["attempts"][0]["assessment"]["flagged"] for x in values for a in x["windows"]),
            unresolvedWindows=sum(x["unresolvedWindows"] for x in values),
            inferenceMedianMs=statistics.median(x["inferenceMs"] for x in values) if values else None,
            inferenceP95Ms=percentile([x["inferenceMs"] for x in values], 0.95),
            elapsedMedianMs=statistics.median(x["elapsedMs"] for x in values) if values else None,
        )
    if rows:
        rng = random.Random(20261023)
        differences = []
        for _ in range(4000):
            sample = rng.choices(rows, k=len(rows))
            denominator = sum(r["variants"]["baseline"]["score"]["referenceWords"] for r in sample)
            delta = sum(r["variants"]["candidate"]["score"]["errors"] - r["variants"]["baseline"]["score"]["errors"] for r in sample)
            differences.append(delta / denominator)
        result["pairedWerDifference95BootstrapCI"] = [percentile(differences, 0.025), percentile(differences, 0.975)]
        result["changedPairs"] = sum(r["variants"]["baseline"]["text"] != r["variants"]["candidate"]["text"] for r in rows)
        result["worsePairs"] = sum(r["variants"]["candidate"]["score"]["errors"] > r["variants"]["baseline"]["score"]["errors"] for r in rows)
    return result


def main():
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/whisper-fallback-eval.json")
    data = json.loads(source.read_text())
    complete = [r for r in data["results"] if not r.get("error") and len(r["variants"]) == 2]
    for row in complete:
        if row["reference"] is not None:
            for variant in row["variants"].values():
                variant["score"] = counts(row["reference"], variant["text"])
    summary = dict(
        inputSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        scorerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        jiwerVersion=importlib.metadata.version("jiwer"),
        rapidfuzzVersion=importlib.metadata.version("rapidfuzz"),
        plannedPairs=len(data["design"]["pairs"]), observedPairs=len(data["results"]),
        failedPairs=[dict(id=r["id"], error=r.get("error", "incomplete pair")) for r in data["results"] if r not in complete],
        missingPairs=[p["id"] for p in data["design"]["pairs"] if p["id"] not in {r["id"] for r in data["results"]}],
        scope="Offline window replay. Read-speech dataset references; podcast has no verified reference. Structural recovery is not certified word accuracy.",
        rollout="RETAIN BASELINE: natural-speech accuracy review and production capture/VAD validation of fallback remain outstanding.",
        groups={},
    )
    for cohort in ["read-speech", "alignment-stress"]:
        rows = [r for r in complete if r["cohort"] == cohort]
        summary["groups"][cohort] = aggregate(rows)
        for language in ["id_id", "en_us"]:
            summary["groups"][cohort + "/" + language] = aggregate([r for r in rows if r["language"] == language])
    for cohort in ["podcast-diagnostic", "silence-control"]:
        rows = [r for r in complete if r["cohort"] == cohort]
        summary["groups"][cohort] = {
            "pairs": len(rows), "independentSourceRecordings": 1,
            "candidateRetries": sum(r["variants"]["candidate"]["retries"] for r in rows),
            "candidateUnresolved": sum(r["variants"]["candidate"]["unresolvedWindows"] for r in rows),
            "changedPairs": sum(r["variants"]["candidate"]["text"] != r["variants"]["baseline"]["text"] for r in rows),
            "pairedAddedInferenceMs": [r["variants"]["candidate"]["inferenceMs"] - r["variants"]["baseline"]["inferenceMs"] for r in rows],
        }
    # Save alignments for manual review, separate from the immutable raw run.
    Path(str(source) + ".scored.json").write_text(json.dumps(dict(summary=summary, results=data["results"]), ensure_ascii=False, indent=2))
    Path(str(source) + ".summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
