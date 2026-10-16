# Thread links in messages

When a coordinator or any agent names another thread of its project, the person reading can open that thread with one click. The prompt asks agents to name threads with the `threadLink` a tool returned, but a model sometimes writes the bare title ("Sent to the Release Chrome extension worker."). The app does not rely on the prompt alone: it links those mentions itself.

## Acceptance criteria

- **AC-1.** A message that names one of its project's threads by title renders that title as a link to the thread, even when the agent wrote plain text. "Sent to the Release Chrome extension worker." links "Release Chrome extension" to that worker.
- **AC-2.** This holds on the project page (the coordinator conversation and worker reports there) and in a thread's own timeline (assistant messages of any thread in a project).
- **AC-3.** Ordinary words are not linked. A title matches only when it is unique among the project's live threads (ignoring case), is not a default title such as "New thread", and either has two or more words written in the thread's exact case, or is quoted or followed by "worker", "thread", "task" or "subagent".
- **AC-4.** Code (fenced and inline), existing Markdown links, autolinks, HTML tags and URLs are left as written. A title inside a longer word or hyphenated name is not linked. The longest matching title wins.
- **AC-5.** A thread's own messages never link to the thread itself; deleted threads are never linked.
- **AC-6.** `delegate_task`, `studio_thread_list`, `studio_thread_send` and the bulk stop and continue tools return a ready-made `threadLink`. A send to another machine returns a link that names that machine. The `studio_thread_send` description tells the agent to name the thread with that link, never its bare title.

## Where it lives

| Part                      | File                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain-mention linker      | `apps/web/src/studio/plainThreadMentions.ts`                                                                                                                                    |
| Project page              | `prepareProjectMarkdown` in `apps/web/src/studio/projectWorkspaceModel.ts`                                                                                                      |
| Thread timeline           | `AssistantTimelineRow` in `apps/web/src/components/chat/MessagesTimeline.tsx`                                                                                                   |
| `studio_thread_send` link | `sendToThread` in `apps/server/src/mcp/OrchestratorMcpService.ts`, `sendRemote` in `apps/server/src/mcp/toolkits/orchestrator/remote.ts`                                        |
| Tests                     | `apps/web/src/studio/plainThreadMentions.test.ts`, `apps/server/src/mcp/toolkits/orchestrator/remote.test.ts`, `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts` |

Linked mentions use the canonical `studio://thread/<encoded id>` href, so they render as the same thread chips as links the agent wrote and count as mentions for the "Threads started" cards.
