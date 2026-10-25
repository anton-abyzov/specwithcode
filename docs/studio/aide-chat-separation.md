# Aide and project conversations

SpecWithCode keeps the personal assistant's conversation separate from project chats.
Mentioning a project does not ask Aide to post into it. Discussion stays in Aide;
requested status, feedback and reports use read tools. Requests to start, change,
stop or steer project work go through `studio_project_route`.

Routing requires `userAsked`, a quote from the user's original request or their
reply that started the current turn. The current turn must also originate from a
user message. An agent-triggered notification cannot replay an old user request.
Quote matching checks provenance, not semantic intent; Aide's instructions decide
whether the user requested action.

Generic agent text, forwarded-message and attachment sends cannot cross into or
out of a personal project. The same boundary covers thread creation, queued-message
edits, scheduled work and bulk controls. Schedule reads omit webhook URLs that
would let another project's agent trigger a personal routine. The server checks
before dispatch or attachment claiming. Aide uses explicit routing for outgoing work and reads a project's
threads when asked for a report. Code-project coordination, same-project workers
and external clients without an agent thread retain their existing permissions.
Existing conversation history is preserved.

## Verification

Focused regression tests exercise the routing toolkit, current-turn provenance,
text and attachment rejection, same-project delivery and cross-project reads.
The isolated `aide-chat-separation.mjs` fixture prepares a production server with
two projects, distinct deferred messages and disabled providers for the
collaborative headless browser. Read both thread projections through their HTTP
endpoints and confirm each contains only its own message. Switch between project
views and reload Aide to check that no project transcript appears there.

This fixture does not bind a coordinator through provider admission, so its main
project conversations show their empty state. Browser evidence covers scoped
transcript reads and project-view switching, not a live conversation's rendered
history. Toolkit tests prove the server refusal paths. Neither proves
natural-language intent classification or acceptance in an installed release.
