# Homepage project stories

The homepage introduces Oliver’s interests in video engineering and mathematics through four projects: Encoding Database, Better VMAF, Keiri, and Lyra.

## Editing the writing

Edit the `project-list` section in both `index.html` and `mobile/index.html`. Each article contains:

- `h3`: project name.
- `project-hook`: a question, observation, or subtitle.
- `project-blurb`: factual or personal context supplied by Oliver. Add more paragraphs with this class when needed.
- `project-link`: a descriptive link to the repository.

Personal anecdotes must come from Oliver. Keep both homepages in sync when editing. No build command is needed for these static sections.

## Presentation

Four full-width entries, separated by thin rules. Project names occupy a narrower left column; hooks, prose, and links occupy the right column. At phone widths each title sits above its writing. Rows grow naturally with the content. Styles live in `css/home.css`.

The Encoding Database title renders as plain heading text — the old orange `span.project-title-accent` initials and `DataBase` casing were retired, so keep the heading plain when editing it.

The project animations are retired and no longer loaded. Their old source files remain available as reference; the old artwork generators are not part of the current authoring workflow, and the `build:project-art` npm command has been removed.

Run `npm run home:check` for responsive layout, accessibility-related structure, artwork fallbacks, and retained homepage interactions. `npm run smoke` checks the four-entry structure and absence of the retired animation runtime.
