import { writeFile } from "node:fs/promises"
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Mark the current pull request as ready after completing a review with no actionable findings.",
  args: {},
  async execute(_args, context) {
    if (context.agent !== "pr-reviewer") throw new Error("This tool is only available to the pr-reviewer agent")

    const readyFile = process.env.PR_REVIEW_READY_FILE
    if (!readyFile) throw new Error("PR_REVIEW_READY_FILE is not configured")

    await writeFile(readyFile, "")
    return "Pull request marked ready."
  },
})
