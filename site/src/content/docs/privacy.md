---
title: Privacy & data
description: What sensus stores on your machine, and the only times anything leaves it.
order: 17
---

Sensus is local-first. There are no accounts, no sign-up, no telemetry, and no usage
reporting. Nothing is sent to the sensus project, and the local service that hosts your
shells and agent turns listens only on your machine.

## What stays on your machine

Everything sensus writes lives in your own directories:

- **Configuration and secrets**: your endpoints, model choice, themes, and the encrypted
  secrets store.
- **Memory**: the durable notes, host map, and journal the agent keeps.
- **Sessions**: the transcripts of your chats.
- **Logs**: the local event, trigger, and service logs, kept for you to read.

See [Configuration](/docs/configuration/) for where each file lives, and
[Memory](/docs/memory/) for what the agent remembers.

## What leaves your machine

Sensus only talks to the services you point it at:

- **Your model endpoint.** The messages you send and any images you attach go to the model
  endpoint you configured, and nowhere else. That is how you get a reply.
- **Your MCP servers.** When the agent uses a tool from a connected MCP server, the call goes
  to that server. Local servers run on your machine; remote servers receive what the call
  carries.
- **The public model catalog.** Sensus fetches the models.dev catalog (public model
  metadata such as context window, image support, and reasoning settings) and your
  endpoint's own model list, to label and populate the model pickers.
- **Instruction links you add.** If your configuration lists a URL as an extra instructions
  source, sensus fetches it when it loads your instructions.

Nothing else. There is no analytics, no crash reporting, no update ping, and no phone-home.
Your terminal output is read only locally, to build the context for a message you send.

## Next steps

- [Configuration](/docs/configuration/): endpoints, secrets, and instruction sources
- [Memory](/docs/memory/): what is stored and how to edit it
- [MCP](/docs/mcp/): the servers you connect
- [CLI](/docs/cli/): read the local logs yourself
