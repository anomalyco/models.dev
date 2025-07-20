<prompt `adr.prompt.md`>

# Guidelines: How to Write Architectural Decision Records (ADRs)

## The Core Principle: One Decision, One File

This is the most important rule: **Every architectural decision is recorded in its own, separate, numbered file.**

We do **not** use a single, monolithic file for all decisions. This practice ensures our decision log is immutable, easy to reference, and avoids merge conflicts. An ADR, once accepted, is a historical artifact that should not be changed. New decisions that invalidate old ones will create new files that supersede the old ones.

## Core Principles for Writing ADRs

- **Be Objective and Dispassionate:** An ADR is a factual record, not a sales pitch. Avoid marketing language ("amazing," "revolutionary") and stick to neutral, technical descriptions.
- **Focus on the "Why":** The `Consequences` section is the heart of the ADR. A decision without its trade-offs is only half the story. Be honest about the downsides.
- **Link to Evidence:** If a decision was based on a performance benchmark, a blog post, or a specific library's documentation, link to it in the `Context` section.
- **Use Clear, Simple Language:** Avoid jargon and complex sentences. The goal is to make the decision understandable to any developer, regardless of their familiarity with the project.

## The ADR Generation Process

When instructed to create or update an ADR, you will follow this process:

### Step 1: Distill the Decision from the Conversation

- **Identify the Core Decision:** What was the final choice that was just agreed upon? (e.g., "We will replace Moment.js with Day.js.")
- **Identify the Context:** What was the problem being solved? (e.g., "The bundle size from Moment.js is too large.")
- **Identify the Consequences:** What are the expected outcomes? (e.g., "Reduced bundle size, but we need to refactor 25 files.")

### Step 2: Determine the Status and Create the New File

- **Status:** Most new decisions will be **"Accepted"**. If a decision replaces an old one, the old ADR's status should be changed to **"Superseded by ADR-XXX"**.
- **Location:** All ADRs must be located in the `.app/adr/` directory.
- **Filename Generation:**
  1. Scan the `.app/adr/` directory to find the highest existing ADR number (e.g., `007-some-decision.md`).
  2. Increment it by one (e.g., `008`).
  3. Create a **new file** with the format: `XXX-short-title-in-kebab-case.md` (e.g., `008-replace-momentjs-with-dayjs.md`).

### Step 3: Write the ADR Using the Formal Template

Use the following markdown template for the content of the **new file**. Do not deviate from this structure.

```markdown
# ADR-XXX: [Short, Descriptive Title of Decision]

- **Status:** [Proposed | Accepted | Deprecated | Superseded by ADR-XXX]
- **Date:** [YYYY-MM-DD]

---

## Context

_**What is the problem or situation that requires this decision?**_

- Describe the issue, the user story, or the technical challenge.
- What are the constraints? (e.g., performance requirements, budget, existing tech stack).
- Be concise. This should be 2-4 sentences.

## Decision

_**What is the change we are making?**_

- State the decision clearly and unambiguously.
- Be specific. Instead of "use a new date library," write "We will replace the `moment` library with `dayjs` across the entire codebase."
- Mention key components of the solution (e.g., "This includes creating a `formatDate` wrapper in `src/utils/dates.ts`").

## Consequences

_**What are the results of this decision? This is the most important section.**_

- **Positive:** List the benefits we gain from this decision (e.g., "Reduces final bundle size by ~80KB," "Simplifies date-time immutability.").
- **Negative:** List the costs, risks, or trade-offs (e.g., "Requires a coordinated refactoring effort across ~25 files," "Day.js does not have built-in support for X, requiring a custom plugin.").
- **Neutral:** Other notable outcomes (e.g., "The team will need a brief training on the new `dayjs` API.").

---

_Optional but Recommended:_

## Options Considered

### [Option 1: e.g., "Keep Moment.js"]

- **Pros:** No refactoring effort required.
- **Cons:** Fails to solve the bundle size problem.

### [Option 2: e.g., "Use `date-fns`"]

- **Pros:** Also lightweight and modular.
- **Cons:** API is less familiar to the team compared to the Moment.js-like API of Day.js, potentially slowing down the refactoring process.
```

</prompt>
