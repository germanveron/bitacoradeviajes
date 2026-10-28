---
name: frontier-interview
description: Run a multi-decision interview as a frontier walk over a decision tree — each round, ask every question whose prerequisites are settled (numbered, each with a recommended answer), fetch facts yourself in the background, recompute the frontier from the answers, and repeat until no open decisions remain. Use whenever a task needs several interdependent decisions from the user (project setup, design direction, architecture choices, merge conflicts). Not for a single question — just ask that directly.
license: MIT
metadata:
  version: "0.1.0"
  invocation: model
---

# Frontier Interview

You need several decisions from the user, and some depend on others. Two failure modes to avoid: dripping questions one at a time (slow, and the user never sees the shape of the problem) and dumping every question at once (later questions are premature — their right framing depends on earlier answers). Instead, walk the frontier of the decision tree.

## The model

1. **Map the decision tree.** Before asking anything, list every decision the task needs. For each one, note its prerequisites: the earlier answers or facts that must be settled before the question can be asked well.
2. **Separate facts from decisions.** A _fact_ is anything answerable by reading the repo, the docs, or the web — package manager, existing conventions, what a library supports. A _decision_ requires the user's judgment, taste, or authority. **Facts are never the user's job.** Fetch them yourself — with background sub-agents where available so fetching doesn't stall the interview — and let only the questions downstream of an unfetched fact wait.
3. **The frontier** is every unasked decision whose prerequisites are all settled. That is what you ask, and all of it, each round.

## The loop

Each round:

1. Kick off fetches for any facts that would unblock questions.
2. Ask the entire current frontier in **one message**: numbered questions, each with a recommended answer and a one-line rationale — "1. \<question\>? **Recommend:** \<answer\> — \<why\>." Make "accept all recommendations" a valid single reply.
3. Accept answers in whatever form they come: full, partial, "all recommended", or pushback that reframes a question.
4. Recompute the frontier. New answers may unlock downstream decisions, reshape how a pending question should be asked, or eliminate it entirely. If an answer invalidates a question you already asked but the user skipped, withdraw it explicitly rather than leaving it dangling.
5. Repeat until the frontier is empty.

## Rules

- Every question carries a recommendation. Never present a menu without a position.
- Never ask the user for a fact you could fetch.
- Never re-ask a settled decision. Carry answers forward verbatim; if you must restate one, quote it.
- Record the outcome where the invoking skill directs (a config doc, a plan, a proposal). The interview itself is not the artifact.

## One-question-at-a-time opt-out

Offer the opt-out and honor it immediately: some users prefer strictly one question per round, and they are not wrong — field experience shows that questions which look independent often turn out coupled once an answer lands. Also invoke this judgment yourself: when the coupling risk in a round is high, shrink the round rather than batch blindly. Batching is an optimization, not the contract; the contract is that every question arrives with its prerequisites settled.
