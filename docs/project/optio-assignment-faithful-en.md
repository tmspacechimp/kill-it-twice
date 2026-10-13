# Technical Assignment: Kill It Twice

*Optio Platform Team | Senior Software Engineer Vacancy*

> **Summary**
>
> This assignment does not test whether you can build a working system. We assume you can (especially with AI). It tests what happens when the system fails and what architecture you use to respond to those situations.

## 1. Context and problem

Optio's platform receives data from client systems and distributes it to its own layers: a search index used for segmentation and an event stream consumed by other services for campaigns and analytics.

This may sound simple, but in practice every component can fail:

- **Two modes, one pipeline:** Initial loading of millions of records, followed by continuous incremental synchronization of changes at a configurable interval. Both read from the same source.
- **Process crash:** A container restarts, or someone deploys, during the third hour of a four-hour load.
- **Destination outage:** The search index does not respond for a minute, or the broker restarts.
- **One bad record:** The destination rejects three records in a batch of 500. The other 497 must not be lost. The three rejected records must not be lost either, even though they cannot be written to the destination index.
- **Lack of visibility:** Is the system running or lagging? Where is the process? How many records were read, and how many were lost?

## 2. Goal

Build a data replication system:

*Source (relational database) → pipeline → two destinations:*

1. **Search index:** Searchable current state of records (Elasticsearch or your choice).
2. **Event stream:** A stream of changes listened to by at least one independent consumer (RabbitMQ or your choice).

The pipeline must support both initial loading (backfill) and continuous incremental synchronization, and both must run concurrently.

Also provide a UI that shows and controls the system.

### Data volume

The exact number does not matter. The volume should be large enough that elementary solutions, such as loading everything into memory, no longer work and the gates are meaningful. Explain the rationale for your data-volume choice in the README; this will also be evaluated.

## 3. Gates — the main part

Five scenarios. Demonstrate that each works by running it, rather than merely describing it in the README.

| # | Gate | Success criterion |
| --- | --- | --- |
| G1 | Crash recovery | Run `docker kill` during a load. After restart, the system continues from where it stopped, without starting over or losing records. |
| G2 | No duplicates | After any number of kills/restarts, each record occurs once in the destinations (or the destinations are idempotent and reprocessing is harmless). State which guarantee you provide—at-least-once, exactly-once, or effectively-once—and demonstrate it. |
| G3 | Destination outage | Stop the search index mid-run. No data is lost, the processor does not enter a busy loop, and the system recovers automatically when the index returns. |
| G4 | Partial batch failure | If three records in a batch of 500 are rejected, 497 are written and three go to a DLQ with enough context for replay. Rolling back the entire batch is unacceptable. |
| G5 | Observability | Using only metrics, logs, and the UI—without reading code—it should be possible to answer: Where is the load? What is the current throughput? What is the incremental lag? How many records are in the DLQ? Is the system healthy? |

## 4. `verify` — what we expect most

The main deliverable is one command:

```bash
make verify   # or ./verify.sh
```

It should automatically check all five gates: kill the process, stop destinations, count duplicates, and print a clear report, for example:

```text
G1 resume after kill ............ PASS (killed at 412,331 / resumed at 412,000, 0 lost)
G2 no duplicates ................ PASS (2,000,000 source / 2,000,000 sink / 0 dupes)
G3 sink outage .................. PASS (60s down, 0 lost, recovered in 4.2s)
G4 partial batch failure ........ PASS (497 written, 3 in DLQ)
G5 observability ................ PASS
```

This is needed to assess your ability to prepare tests for the edge cases of the system you built. If the verify script cannot pass a gate, leave it as FAIL and explain why in the README.

## 5. UI

The UI should show information about the pipeline and allow users to manage it:

| # | Capability | Details |
| --- | --- | --- |
| 1 | Pipeline state | Load progress, throughput, incremental lag, DLQ count, and health. This is the visual side of G5. |
| 2 | Data browsing | List and search replicated records, view details, and see changes in real time. |
| 3 | Management and control | Start/stop loading, replay from the DLQ, and configure parameters. |
| 4 | Simulation controls | Manually trigger failures: stop destinations, inject a bad record, and generate source changes. |

A finished, production-grade UI is not required. It must be functional enough for an unfamiliar user to operate.

## 6. Specification — what you gave the AI to do

We assume you will use AI for this assignment. It is fully acceptable, and we welcome it. But if an agent writes the code, your real work is the specification you prepared. That is what we want to see.

The repository should therefore contain:

1. **SPEC.md:** The document underlying your work: what to build, under which constraints, which decisions have been made, and which remain open.
2. **Specification history:** A commit history in which SPEC.md appears before the code and changes over time. The specification versions (v1 → what did not work → v2) interest us more than the final text.
3. **AGENTS.md:** The instructions you would give an agent working in this repository: conventions, where things belong, what not to touch, and how to check its work.
4. **README section “Where AI diverged from the specification”:** At least two concrete cases: what you asked AI to do, why the result was wrong or insufficient, and what you did to correct it.

### If you do not work from a specification

Some engineers start with code and form their thinking afterward. That approach is legitimate. In that case, instead of SPEC.md, provide what actually led to your decisions (plans, notes, and architectural changes during development). We value honesty and accuracy in recording the process, not the format or appearance of the document.

**What we do not require:**

- Chat logs. Do not send a 200-page transcript. We want the document you wrote and revised to guide your work, like a technical assignment.
- A specification that did not actually guide implementation. A document written retroactively, which perfectly matches the outcome and records no deviations, is not of interest.

## 7. Acceptance criteria

- [ ] Both modes work: initial loading and continuous incremental synchronization concurrently.
- [ ] Data reaches both destinations; the event stream has at least one independent consumer.
- [ ] Data volume makes the gates meaningful; the choice is justified in the README.
- [ ] All five gates can be run with `make verify`, which prints PASS/FAIL.
- [ ] The delivery guarantee is clearly stated in the README and matches the code.
- [ ] There is a DLQ and a way to replay from it.
- [ ] The UI covers state, data, management, and simulation.
- [ ] `docker compose up` starts the whole system with one command.
- [ ] SPEC.md exists, appears in the commit history before code, and subsequently changes.
- [ ] AGENTS.md exists.
- [ ] The README contains at least four ADRs: decision, alternatives, and trade-offs.
- [ ] The README contains an architecture diagram.
- [ ] The README contains Capacity Notes: measured throughput, bottleneck, and recommendations.
- [ ] The README has a “What I did not build and why” section.
- [ ] The README has a “Where AI diverged from the specification” section with at least two cases.

## 8. Technology stack

We work with NestJS, Angular, RabbitMQ, Redis, Elasticsearch, Docker, S3, ClickHouse, and Apache NiFi. However, you may choose other technologies with which you can work most quickly and effectively.

## 9. Submission format and instructions

Submit a link to a public GitHub repository through careers.optio.ai. The repository should include:

- `docker compose up` — starts the entire system locally.
- `make seed` — generates data.
- `make verify` — automatically checks the gates.
- SPEC.md and AGENTS.md — specification and agent documentation.
- README.md with:
  - Run instructions (prerequisites, seed, verify).
  - An architecture diagram (Mermaid, draw.io, or another format) showing components, data flow, checkpoint locations, and DLQ.
  - At least four ADRs (decision, alternatives, trade-offs).
  - An explicit delivery-guarantee statement.
  - Capacity notes: measured throughput, bottleneck, and what you would change to double it.
  - “What I did not build and why.”
  - “Where AI diverged from the specification” (at least two cases).
  - A table of gates with PASS/FAIL and honest explanations for failures.

## 10. Deadline, scope, and AI usage

*Deadline: 10 calendar days from opening the assignment.*

The assignment is deliberately larger than ten working days because managing scope is part of the assessment. Decide what to leave out and explain why. If you run out of time, reduce functionality rather than gate quality: three fully working gates are better than five half-implemented ones. What you cut and how you explain it will be evaluated separately.

### AI usage

Use AI without restrictions. It is an everyday tool here, and we expect you to know how to manage it effectively.

We do not ask for SPEC.md to determine what percentage AI wrote; that is neither possible nor interesting. We want to see how you directed the work, when you intervened, and how you managed the process.

In the technical interview, we will discuss a specific part of your system and ask you to explain it. We will also discuss one divergence between SPEC.md and the code and ask whether it was a decision or an accident.
