# Allow another machine to run work here

In SpecWithCode on the destination machine, open Settings > Machines > Who can run work here. Choose the machine that will send work, choose the maximum access for that work, and select Allow [machine] to run work here. Read the confirmation before approving: setup gives the sending machine a management key as well as worker access. Both machines must be connected with Manage access, and setup requires the installed desktop app. If the sending machine already lists the destination, setup reuses that line and its key, so a retry after a failed grant does not issue another key. It adds the line again only when its saved key cannot work, and then only once per page session.

For example, on M4, choosing M1 sets up M1 → M4. The existing M1 card under M4's Connections page instead controls M4 → M1. A connected app or an update permission does not imply a worker grant in either direction.

The setup uses the existing machine invitation and worker-grant flow. Existing project and sign-in limits remain enforced. If adding the machine succeeds but granting work fails, the page reports partial setup. On the sending machine, open Settings > Machines and choose Allow workers on the destination's card. Existing or revoked incoming grants retain their controls above the setup section.

Signing keys and other secret files still need a separate owner approval for each studio_file_transfer. A worker started by another machine cannot initiate fleet transfers: its coordinator sends the file. Approved project folders and secret-transfer restrictions still apply. Allowing workers does not authorize reading every file on the destination.
