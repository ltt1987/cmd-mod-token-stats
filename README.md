# Token Stats Mod

A Command Code mod that shows live token usage, prompt-cache statistics, and generation speed in the status footer.

## Features

- Displays the prompt-cache hit rate.
- Tracks input, output, cached, and uncached token totals.
- Shows the latest request's token speed and time to first token (TTFT).
- Shows the session-wide average output speed.
- Provides a `/cache` command with a detailed cache and token breakdown.
- Keeps totals across `/reload` and session resume.
- Breaks cache statistics down by model when multiple models are used.

## Installation

### Install Globally

Install the mod directly from GitHub:

```sh
cmd mod add git:https://github.com/ltt1987/cmd-mod-token-stats
```

Verify that Command Code detects it:

```sh
cmd mods list
```

You should see `token-stats` listed as a user mod. Start a new Command Code session, or run `/reload` in an existing session.

To update the mod after a new release:

```sh
cmd mod update token-stats
```

### Load for One Session

To load the mod without installing it globally:

```sh
cmd --mod ./src/index.ts
```

## Project Structure

```text
src/index.ts   Mod entry point
package.json   Package metadata and ESM configuration
```

## Usage

The status footer shows the current cache and token statistics automatically after a model request completes.

Run `/cache` to display a detailed report in the conversation feed:

```text
/cache
```

The exact token usage is updated when the model request finishes, because providers report final usage data at the end of the request.
