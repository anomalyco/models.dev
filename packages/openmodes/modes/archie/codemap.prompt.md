<prompt `codemap.prompt.md`>

# Guidelines: How to Write the Codebase Map

The `codemap.instructions.md` file is the "owner's manual" for this application. Its purpose is to provide a high-level, conceptual understanding of the architecture, enabling any developer (or AI) to quickly grasp how the system works without reading every line of code.

This is a living document. It must be updated whenever a core architectural pattern is introduced or changed. It must live at `.github/instructions/codemap.instructions.md` and be referenced in the main README.

---

## 1. Core Principles

- **Focus on the "Why" and "How":** Don't just list what files exist. Explain _why_ they are structured a certain way and _how_ data flows between them. The goal is to reveal the non-obvious patterns.
- **Use the "Nouns and Verbs" Analogy:** Structure the document to first explain the core data entities (the "Nouns") and then the architectural patterns that act upon them (the "Verbs").
- **Prioritize the Abstract over the Concrete:** This is not a replacement for code comments. Avoid implementation details and focus on the high-level architecture. For example, explain the _concept_ of the "Bundle-and-Hydrate" pattern, not the specific implementation of a `for` loop within it.
- **Link to Key Files:** Always reference the primary files that implement a given pattern (e.g., `src/hooks/fetchUserData.ts` for data fetching). This allows readers to jump directly to the source for more detail.

---

## 2. Required Sections

Your `codemap.instructions.md` file must include the following sections in this order.

### **Section 1: High-Level Overview**

- **Purpose:** A one-sentence summary of the application's purpose.
- **Core Technologies:** A bulleted list of the main technologies used (e.g., React, Convex, Zustand, TailwindCSS).

### **Section 2: Core Concepts (The "Nouns")**

- **Purpose:** To define the primary data entities of the application.
- **Content:** A bulleted list of the main data models (e.g., `Company`, `Project`, `Quote`, `Invoice`). Briefly describe what each entity represents and its relationship to others.

### **Section 3: Architectural Patterns (The "Verbs")**

- **Purpose:** This is the most critical section. It explains the fundamental "rules" of how the application operates.
- **Content:** For each major pattern, create a subsection that includes:

  - **Concept:** A clear, concise explanation of the pattern's purpose.
  - **Key Files:** A list of the file(s) where this pattern is primarily implemented.
  - **Flow:** A step-by-step description of how the pattern works.
  - **Do / Don't:** Provide clear, simple code examples of the correct and incorrect ways to interact with the system.

- **Required Patterns to Document:**
  - **Data Fetching & Hydration:** The "Bundle-and-Hydrate" pattern.
  - **State Management:** Zustand as a client-side cache.
  - **Data Mutation:** The `useSmartMutations` hook.
  - **Authentication Flow:** The `CompanyGuard` and `ProtectedRoute` logic.
  - **Logging & Debugging:** The central `Logger` and its purpose.

### **Section 4: Key Directory Guide**

- **Purpose:** To provide a quick reference for navigating the project.
- **Content:** A bulleted list of the most important directories (`convex/`, `src/stores/`, `src/lib/convex/`, etc.) with a one-line description of their purpose.

---

## 3. What to Avoid

- **❌ Don't explain basic syntax:** Do not explain what a React component or a TypeScript interface is. Assume the reader is a competent developer.
- **❌ Don't list every file:** This is not a file index. Only mention the most critical files that define an architecture.
- **❌ Don't write a tutorial:** The document should be a reference, not a step-by-step guide on how to build a feature.
- **❌ Don't let it get stale:** If you change a core pattern, your first responsibility is to update this document.

</prompt>
