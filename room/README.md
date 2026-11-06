# Claude Room

A shared chat room where you and the people you invite work with Claude together.
**Everyone uses their own Anthropic API key**, so whoever asks Claude a question pays for that answer.

## Run it

```bash
cd room
npm install
npm start
```

Open http://localhost:3000, enter your name and API key, create a room, then press **Invite** and send the link to your teammates.
For people outside your network, host it somewhere public (any Node host such as Render, Railway, Fly.io or a VPS) or use a tunnel like `cloudflared tunnel --url http://localhost:3000`.

## How it works

- Everyone in the room sees every message, live.
- Press **Ask Claude** (or Ctrl+Enter, or start a message with `@claude`) to bring Claude in. Claude reads the whole room conversation, knows who said what, and the reply streams to everyone.
- That request is made with **your** key and your chosen model (Opus 5.5, Sonnet 5.5 or Haiku 5.5) and effort, set in **Settings**. Each reply shows who paid and how many tokens it used.
- You can join without a key and just chat; you only need one to ask Claude.
- Rooms are saved to `data/` (messages only, never keys), so the history is there when people come back.

## Use your Claude subscription instead of an API key (Pip)

Each person can choose in **Settings** how their own questions are paid:

- **My Anthropic API key**: the server calls Claude with your key (pay per use).
- **My Claude subscription (Pip desktop pet)**: install [Pip](../README.md) on your computer, sign in to Claude Code with your Pro/Max plan, and connect Pip to the room with the pairing code shown in Settings. When you press Ask Claude, the room sends the conversation to *your* Pip, which runs *your* Claude Code and streams the answer back to everyone. The server never sees any Claude login. Your computer must be on with Pip running.

People can mix both in the same room. The 🔑 and 🐾 icons in the People list show who can ask Claude and how.

## About your API key

- It is saved in your own browser (localStorage) and sent to the server when you join.
- The server keeps it in memory only for your connection, uses it only for questions you ask, and never writes it to disk, logs it, or sends it to other people.
- Whoever runs the server could in principle read keys that pass through it, so only use a server run by you or someone you trust, and serve it over HTTPS when it's public.
- Anyone with a room link can join that room; links contain a random part so they can't be guessed.

## Why the subscription option goes through Pip

Anthropic doesn't allow apps to log in to Claude with someone's subscription or to store their Claude login. It does allow a person to run the unmodified Claude Code program with their own subscription, even when another app starts it for them. So the subscription option works by having each person's own Pip run their own Claude Code on their own computer, the same pattern Conductor (formerly Melty) uses. See [docs/subscriptions-research.md](../docs/subscriptions-research.md) for the research.
