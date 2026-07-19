# Deployment guide

This guide walks through deploying MeshCore-BTC on a host with a MeshCore device attached over USB. It's written to
be host-agnostic - replace `<host>` with wherever you're actually deploying (a Raspberry Pi, a home server, a VPS
with a USB passthrough, etc).

## Prerequisites

- Node.js 22+ (LTS) installed on `<host>`.
- The MeshCore device (Companion USB firmware) plugged into `<host>`, with a known serial device path (e.g.
  `/dev/ttyACM0` on Linux, `/dev/tty.usbmodemXXXX` on macOS).
- Your user account has permission to open that serial device (see [Troubleshooting](#troubleshooting) below).
- If you're enabling the `ai` module: [Ollama](https://ollama.com) installed and running on `<host>` (or reachable
  over the network from it), with the model you intend to use already pulled:
  ```sh
  ollama pull gemma4:12b-mlx
  ```

## Initial install

```sh
ssh <host>
git clone https://github.com/jooray/MeshCore-BTC.git
cd MeshCore-BTC
npm install
cp config.json-example config.json
```

## Configure

Edit `config.json` on `<host>`. At minimum, adapt these keys for your setup:

- **`port`** - the serial device path for your MeshCore device on `<host>`. You can also leave this as a
  placeholder and instead pass the port as a command-line argument (`node index.mjs /dev/ttyACM0`), which overrides
  `port` from the config.
- **`bitcoin.channel`** (and/or the legacy `channels.bitcoin`) - the exact name of the channel to broadcast price
  updates to. Must match a channel already configured on the device.
- **`ai.channels`** - which channels the AI module should listen on, and in what mode (`"mention"` or `"all"`).
  Leave this as `{}` if you only want the AI module to answer direct messages. See the README's
  [AI module](README.md#ai-module) section for the semantics and the bot-loop warning around `"all"` mode.

See `README.md` for the full config reference.

## Run it

Run under `tmux` (or `screen`) so it survives your SSH session ending:

```sh
ssh <host>
cd MeshCore-BTC
tmux new -s meshcore-btc
./run.sh
# detach with Ctrl-B then D
```

To re-attach later:

```sh
ssh <host>
tmux attach -t meshcore-btc
```

`run.sh` is a supervisor loop: it restarts `node index.mjs` automatically whenever it exits, whether from a crash
or the watchdog (see README). This means a plain `Ctrl-C` inside the tmux session kills the current `node`
process, but `run.sh` will just start a new one 10 seconds later. **To actually stop the bot**, press `Ctrl-C`
again quickly (before the restart happens) so both the supervisor loop and `node` are killed, or from another
shell:

```sh
pkill -f run.sh; pkill -f "node index.mjs"
```

## Updating

```sh
ssh <host>
cd MeshCore-BTC
git fetch
git checkout modular-ai   # or whichever branch/tag you're deploying
git pull
npm install
```

Then restart: attach to the `tmux` session and stop the bot as described above (both `run.sh` and `node`), then run
`./run.sh` again. Since `run.sh` restarts `node index.mjs` on any exit, a plain crash during an update won't lose
your session - but a deliberate `Ctrl-C`+`Ctrl-C` (or the `pkill` above) is needed to actually pick up new code,
since `run.sh` itself doesn't re-read the repo.

## Testing the AI module locally

Before wiring it into the bot, you can sanity-check that Ollama is reachable and the model responds, from `<host>`
(or wherever Ollama is running):

```sh
curl http://localhost:11434/api/chat -d '{
  "model": "gemma4:12b-mlx",
  "stream": false,
  "messages": [
    { "role": "system", "content": "Answer in under 20 words." },
    { "role": "user", "content": "What is Bitcoin?" }
  ]
}'
```

You should get back JSON with a `message.content` field. If this call fails or times out, the `ai` module will
behave the same way against the real mesh: direct messages get a canned "AI unavailable right now" reply, and
channel messages fail silently (logged only).

## Troubleshooting

- **Serial permission denied** - on Linux, your user usually needs to be in the `dialout` (Debian/Ubuntu) or
  `uucp`/`tty` (other distros) group to open `/dev/ttyACM*` without root:
  ```sh
  sudo usermod -aG dialout $USER
  # log out and back in for group membership to take effect
  ```
- **Bot keeps restarting with `WATCHDOG:` in the logs** - this means the connection to the device went quiet for
  longer than `watchdogTimeoutMinutes` (default 6h). Check the USB cable/hub, and check dmesg/system logs around
  the restart time for signs of the device dropping off the bus. A single occasional watchdog restart is expected
  and harmless; frequent ones indicate a flaky USB connection or device firmware issue.
- **AI replies are slow or time out** - increase `ai.requestTimeoutSeconds` if your model/hardware is just slow, or
  switch to a smaller/faster model. Ollama calls are made one at a time (serialized), so a slow model also delays
  subsequent replies; check the logs for `Ollama call failed` / timeout messages.
- **AI module never replies in a channel** - check that the channel name is spelled exactly as configured on the
  device in `ai.channels`, and remember `"mention"` mode requires the bot's own name (from `getSelfInfo()`) to
  appear in the message text.
