// Watchdog: the serial link to the MeshCore device can go silent without
// emitting an error (device hang, USB glitch, etc). We track the last time
// the connection produced any activity, and if it goes quiet for too long,
// exit with a distinct code so run.sh knows to restart us.
export function startWatchdog(connection, { timeoutMinutes = 360, exitCode = 42 } = {}) {
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let lastActivity = Date.now();

  const touch = () => {
    lastActivity = Date.now();
  };

  // Instead of monkey-patching connection.emit (which fired on literally
  // every event, including ones we generate ourselves), we listen on the
  // lowest-level signal that real device activity happened: raw 'rx'
  // frames, plus 'connected' so a fresh connection always starts the clock.
  //
  // Trade-off: a mesh that is genuinely and completely silent (zero RX
  // frames from the radio - no repeaters, no adverts, nothing at all in
  // range) for the full timeout window will trigger a restart even though
  // the serial connection itself is perfectly healthy. In practice a live
  // MeshCore mesh is essentially never that quiet, and a restart in that
  // scenario is harmless (run.sh just reconnects), so this is an acceptable
  // false-positive rate in exchange for much simpler activity tracking.
  connection.on('rx', touch);
  connection.on('connected', touch);

  const interval = setInterval(() => {
    const idleMs = Date.now() - lastActivity;
    if (idleMs > timeoutMs) {
      console.error(`WATCHDOG: no activity from MeshCore device for ${Math.round(idleMs / 60000)} minutes, exiting (code ${exitCode}) for restart`);
      process.exit(exitCode);
    }
  }, 60 * 1000);

  return {
    stop: () => clearInterval(interval),
  };
}
