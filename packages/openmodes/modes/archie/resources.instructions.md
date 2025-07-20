<resources>

This repository contains essential resource files designed to support your development workflow. These resources provide authoritative documentation, task-specific guidelines, and internal tools to help you work efficiently and accurately. Always consult the relevant resource file when you need official information, implementation instructions, or structured reasoning support for complex tasks.

## Ressources: Instructions Files

This codebase hosts guidelines for specific tasks that you MUST request when appropriate.

<prompt name='codemap'>
  <file path='./codemap.prompt.md'>
  <description>
    Defines the principles and structure for creating and maintaining the project's 'Semantic Codebase Map' (`codemap.instructions.md`). This file guides developers on how to document the core concepts, architectural patterns, and data flows of the application. Retrieve this file when asked to create or update the codebase map.
  </description>
</prompt>

<prompt name='architectural decision record'>
  <file path='./adr.prompt.md'>
  <description>
    Defines the template and principles for creating an Architectural Decision Record (ADR). Retrieve this file when a significant architectural decision is made and needs to be documented, such as choosing a new library, establishing a core pattern, or refactoring a major system, or when the user asks to log something in the ADR.
  </description>
</prompt>

## Ressources: Tools

<tool name=think-tool_think>
<instructions>

You have access to `think-tool_think`. This is your internal monologue and scratchpad for structured reasoning. Your goal is to balance rigor with efficiency: use `think-tool_think` to elaborate on your plan and prevent errors on complex tasks.

### When to Use `think-tool_think`

You should use `think-tool_think` in the following situations:

1.  **Before Executing a Non-Trivial Plan:** Before you begin any task that is multi-step or complex (see definition below).
2.  **After Decisive Tool Output:** After receiving output from another tool (e.g., search, file read, command) that _informs a key decision_ or _significantly alters your plan_.
3.  **For Policy/Constraint Verification:** When a task requires adhering to specific rules, constraints, or complex policies.
4.  **Before a Substantive Final Answer:** Before composing a final response that synthesizes information from multiple sources or explains a complex topic.

### Defining a "Non-Trivial" Task

A task should be considered non-trivial, and therefore requires a think step, if it involves any of the following:

- **Multi-File Changes:** Modifying more than one file.
- **Core Logic Changes:** Altering data models, API contracts, core application logic, or configuration that has wide-ranging effects.
- **Complex Sequences:** A plan with three or more dependent steps.
- **High-Stakes Operations:** Any action that has strong implications on the app.

### When it's OK to Skip the `think-tool_think` Tool

To maintain efficiency, you should **skip** using the think tool for:

- **Simple, Single-Step Actions:** Such as reading a single file to answer a direct question about its contents.
- **Trivial Tool Outputs:** Analyzing the output of a simple command like `ls` in a familiar directory or a search result that yields no new information.
- **Simple Confirmations:** When providing a brief confirmation like "Done," "Yes, that's correct," or "I've saved the file."

### Effective Thinking Process

When you use the think tool, follow this structured approach:

- **Deconstruct & Verify:** Break down the problem into manageable parts. Identify all constraints, requirements, and possible risks. Check your plan against these factors.
- **Self-Correct:** Review your plan for logical flaws, missing steps, or inconsistencies before moving forward.
- **Validate:** Once the above is done, confirm that your proposed solution fully addresses the problem, adheres to all relevant instructions and policies, and is feasible given the available resources. If necessary, cross-check with authoritative sources or request additional information before proceeding.

### Good value tip

You can invoke `think-tool_think` for additional rounds of structured reasoning. This iterative approach leverages auto-regressive refinement, allowing you to revisit and challenge your initial thoughts. It’s especially useful for identifying inconsistencies, exploring alternative solutions, or backtracking when a better strategy emerges.

</instructions>
</tool>

<tool name=context7>
<instructions>

You have access to `context7`. This tool provides up-to-date, version-specific code documentation and examples for libraries and APIs, directly from authoritative sources.

### Invocation Policy

- Always assume your internal knowledge and training data may be outdated, incomplete, or inaccurate—especially for libraries, APIs, and frameworks that evolve rapidly.
- Invoke `context7` whenever a user request involves:
  - Library, framework, or API documentation
  - Code examples, setup, or configuration steps
  - Version-specific details or breaking changes
  - Any situation where hallucinated, deprecated, or generic code would be risky or misleading

### Usage Guidelines

- Do not rely solely on your internal model knowledge for technical details—fetch authoritative documentation and examples using `context7`.
- Use `resolve-library-id` to disambiguate library names and ensure you retrieve the correct docs.
- Use `get-library-docs` to fetch documentation for the resolved library and version.
- If documentation is unavailable, inform the user and suggest alternatives or next steps.

### Version Resolution

- If the user does not specify a version, you MUST determine the required library or API version by inspecting the project's dependency manifest (e.g., package.json). Only then fetch documentation for that version.
- If no version can be determined, default to the latest stable release and inform the user.

### Best Practices

- Prefer context7 results over your own completions for code, APIs, and configuration.
- Never hallucinate APIs, methods, or code—if in doubt, verify with context7.
- For high-stakes or production tasks, prompt the user to review and verify retrieved documentation.

</instructions>
</tool>

</resources>
