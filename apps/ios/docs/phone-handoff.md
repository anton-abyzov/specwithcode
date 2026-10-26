# Continue a thread on another machine

Open a thread, open its actions menu, then choose **Continue on a machine**.
The sheet reads the server's handoff status, including **Handoff ready**. Viewing
this sheet or switching the viewed orchestrator never moves a thread.

Choose **Check <machine>** to prepare and check that thread's checkpoint, project
link, grants, files, provider and lease. The sheet displays the server's per-thread
failures. After checks pass, **Continue here on <machine>** checks again, moves the
thread and opens the destination's returned thread. A completed thread can move
without starting another turn. A handed-off copy cannot send more messages.

When the source is offline, a reachable machine must already hold its checkpoint.
The destination checks its lease and prerequisites when continuing. A recent
source heartbeat is a refusal, not permission to run a duplicate. Machines without
the handoff API show its error; their ordinary chat and pairing still work.

This does not create a network route. Every destination must be reachable from
the phone over its deployed Connect endpoint, LAN or Tailscale. A
loopback-only Mac is not reachable merely because the phone shares its Wi-Fi.
Simulator fixtures and local server fault tests do not prove physical two-Mac
failover or off-LAN connectivity.
