# Telegram channel

Talk to one project's coordinator from your phone. A message you send in Telegram becomes work for that coordinator on your machine. Its answer comes back to the chat, and so do routine results and notices that an agent is waiting for your approval. With a Personal project, this works like a personal agent such as OpenAI's Dots or a Telegram bot assistant, except that the agent, its memory and its tools stay on your own machine.

## Set it up

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you.
2. In SpecWithCode, open **Settings > Messaging**. Paste the token, choose a project, and press **Connect bot**. A Personal project suits everyday errands. A code project lets you check on its work from your phone.
3. Scan the QR code with your phone, or send `/start <code>` to your bot. The page changes to **Paired** once the chat is accepted.

Open the project in SpecWithCode at least once so that its coordinator thread exists. Until then, the bot replies that the coordinator has not started.

## What the chat does

| You send             | What happens                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Any text             | Queued in the coordinator thread as your message. It never interrupts work already running.          |
| `/status`            | Shows the project, and whether the coordinator is working or idle and how many messages are waiting. |
| `/help`              | Lists these commands.                                                                                |
| Photos, files, voice | Not supported yet. The bot says so.                                                                  |

When a coordinator run finishes, the chat gets its last answer if you started that run outside SpecWithCode: from Telegram, a routine, or a worker reporting back. Runs you start in SpecWithCode's web or mobile app are not echoed to the chat. If any thread in the project asks for an approval or an answer, the chat gets a notice. Approvals themselves are given in SpecWithCode.

## Security

- SpecWithCode makes long-poll requests to the Telegram Bot API. Nothing on your machine is opened to the internet, and no relay or public URL is used.
- Only one private chat is accepted: the first one that sends the current pairing code. The code is ten characters, can be used once, and expires after 30 minutes. Once a chat is paired, the bot ignores every other chat without replying. **Unpair chat** issues a new code.
- The bot token is kept in the host's secret store (`<stateDir>/secrets`, mode 0600). Clients never receive it back. It is left out of request traces and error messages, because it is part of every Bot API URL.
- Changing the channel requires settings-write access to the environment. Reading its status requires orchestration-read access, and the status shows only the paired person's Telegram name.
- Telegram stores chat messages on its own servers. Do not send secrets through the chat.

Answers arrive only while the machine running SpecWithCode is awake. Turn on **Keep awake while sessions work** if the chat should keep working overnight.

## Verify

`node scripts/studio-telegram/verify.mjs /absolute/report-dir` runs the built server in a new private home against a local fake Bot API (`STUDIO_TELEGRAM_API_URL`). The check creates a Personal project, connects and pairs through the Settings page in headless Chromium, and checks the bot's replies, that strangers are ignored, and that the token never appears in status responses or the server log. It starts no provider turn.
