# Your first feature

The first feature guide walks you through one small feature from start to finish on a sample project: SpecWeave turned on, one request to the coordinator, the plan on the Board, a review by a model from another family, and the card in Done. It takes about as long as your agents need to build a dark mode switch for one page.

## Start it

The Overview shows a card, **Build a first feature**. Press **Try a first feature**. The button reads **Sign in an agent first** until one of your agents is signed in.

SpecWithCode makes a sample project called **First feature**: a Git repository with one page (`index.html` and `style.css`), a `package.json` with one passing test, and a README. It starts with SpecWeave off. Its own **Review finished features automatically** setting is turned off, so the only review is the one the request asks for.

The guide sits at the top of the sample's page. It is a card, not a dialog: the rest of the page works as usual.

## The three steps

The card shows three knots on one line, **Turn SpecWeave on**, **Ask for it whole** and **Read the review**, then the current step's sentence and its action.

1. **Turn SpecWeave on.** "This project has no plans or board yet. Turn SpecWeave on." **Show me** opens the Board tab and points at **Set up SpecWeave**. The step is done once SpecWeave is on in the project.
2. **Ask for it whole.** "Ask for the whole feature in one request." **Write it for me** puts the request in the coordinator's message box, and you send it yourself. **Open the thread** opens the coordinator. While the work runs, the step says where the card is: **Planning**, **Working: 1 of 4 tasks**, **In review** or **Fixing what the review found**.
3. **Read the review.** "When the card is in Done, open it and read what the review found." **Open the review** opens the card, which lists who reviewed the work and their verdict. A review by a model from the same family as the builder is labelled as such. When no agent from a second family is ready, the request leaves the review out, and the step names agents that could review it.

**Skip this step** moves on without the step. **Leave the guide** puts it away. A step that cannot go on says **Waiting on this step** and where to look: the Board tab for SpecWeave, the coordinator's last message for the request.

## The end

The card reads "That is the loop: plan, board, work, review, done." and offers two actions; neither is chosen for you:

- **Review finished features in all projects on this Mac** turns on automatic review for every project on this machine. Each review uses the reviewer's plan.
- **Remove the sample project** removes the sample from SpecWithCode. Its folder and files stay on disk.

After a guide finishes, the Overview no longer offers the card on that machine, also after the sample is removed.

## Open it again

- On the sample's page, after you left the guide or closed its end, the project's **⋯** menu has **First feature guide**.
- The command palette has **First feature guide**. It opens the sample in progress, or makes a new one, also after a guide has finished.
- While a sample is in progress, the Overview card reads **Continue your first feature** with **Open it**.

The close button on the Overview card hides the card on this device. The palette entry stays.

## Remove the sample

Use **Remove the sample project** at the end of the guide, or remove the project from its menu like any other. Removing it also removes the sample's own review setting. The folder stays on disk.

A browser window open on another address of the same machine keeps showing the Overview card until it reloads. Pressing it there makes a new sample.
