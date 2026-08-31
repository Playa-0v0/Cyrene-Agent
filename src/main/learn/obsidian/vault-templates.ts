/**
 * Learn Vault initial file templates.
 *
 * When a user binds an empty directory as the Learn workspace, these files
 * are written to establish a consistent convention for notes, materials,
 * exercises and progress tracking.
 */

export const VAULT_README_MD = `# Cyrene Learn Workspace

This is your **Cyrene Learn workspace**. Cyrene will help you read materials, take notes, create exercises, track progress, and review what you have learned.

## Directory layout

| Path | Purpose |
| --- | --- |
| \`materials/\` | Original learning materials (papers, articles, code snippets, etc.). Read-only by default. |
| \`notes/\` | Learning notes maintained by you and Cyrene. |
| \`exercises/\` | Exercises, quizzes, mistakes and review notes. |
| \`templates/\` | Reusable templates for notes and reviews. |
| \`learn/progress.md\` | Overall learning progress, maintained by Cyrene. |

You can create any subdirectories under \`materials/\`, \`notes/\` and \`exercises/\` for different subjects. For example:

\`\`\`
notes/
├── English/
├── Math/
├── TypeScript/
└── PaperReading/
\`\`\`

## How to start

1. Put a paper, article or code file into \`materials/\`.
2. Tell Cyrene: "I want to learn this."
3. Cyrene will read the material, discuss it with you, and offer to take notes in \`notes/\`.
4. After a learning session, Cyrene will update \`learn/progress.md\` silently.

> Do not manually edit \`learn/progress.md\` unless you know what you are doing. Cyrene keeps it up to date after each session.
`;

export const MATERIALS_README_MD = `# Materials

Put your original learning materials here.

Examples:

- PDFs or text exports of papers
- Articles saved as Markdown
- Code snippets or repository notes
- Lecture transcripts
- Book chapters

Cyrene reads files in this directory when you ask about them. By default she does **not** modify files here, so your originals stay intact.

You can organize materials into subdirectories by subject or project.
`;

export const NOTES_README_MD = `# Notes

This is where Cyrene writes learning notes for you, and where you can write your own notes too.

Suggested practice:

- One major topic per file, e.g. ` + "`notes/Subject/Topic.md`" + `.
- Use the template in ` + "`templates/topic-template.md`" + ` as a starting point.
- Link related notes with Obsidian wiki-links: ` + "`[[Another note]]`" + `.
- Add tags like ` + "`#concept`" + ` or ` + "`#paper`" + ` so Cyrene can find them later.
`;

export const EXERCISES_README_MD = `# Exercises

This directory is for exercises, quizzes, mistakes and review notes.

Suggested practice:

- Use ` + "`templates/review-template.md`" + ` for review sessions.
- Name files by topic and date, e.g. ` + "`exercises/TypeScript/2026-08-04-generics.md`" + `.
- Mark questions you still find difficult so Cyrene can revisit them.
`;

export const TOPIC_TEMPLATE_MD = `---
created: {{date}}
status: in-progress
tags: []
---

# Topic name

## Learning goal

- What do you want to understand?

## What I already know

- 

## Questions

- 

## Key resources

- 

## Key concepts

### Concept 1

## Summary

## Next steps
`;

export const REVIEW_TEMPLATE_MD = `---
date: {{date}}
topic:
---

# Review: {{topic}}

## What I learned today

## What still confuses me

## Cyrene's feedback

## Next steps
`;

export const PROGRESS_MD = `---
updated: {{date}}
---

# Learning progress

## Active topics

- 

## Completed

- 

## To start

- 
`;

/**
 * Replace {{key}} placeholders in a template with values from `replacements`.
 */
export function renderTemplate(template: string, replacements: Record<string, string>): string {
  return template.replace(/{{(\w+)}}/g, (_, key: string) => replacements[key] ?? "");
}
