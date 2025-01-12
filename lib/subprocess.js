const subprocesses = [];

function isProcessAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * @returns {void}
 */
export const killSubprocesses = () => {
  for (const proc of subprocesses) {
    if (!proc) continue;

    proc.unref?.();

    try {
      process.kill(-proc.pid, 'SIGTERM');

      setTimeout(() => {
        if (isProcessAlive(proc?.pid))
          process.kill(-proc.pid, 'SIGKILL');
      }, 5000);
    } catch (ex) {
      if (ex.code !== 'ESRCH') {
        console.error(ex);
      }
    }
  }
};

/**
 * @param {ChildProcess} process
 * @returns {void}
 */
export const recordProcess = (process) => {
  subprocesses.push(process);
};

process.on('SIGTERM', () => killSubprocesses());
process.on('SIGUSR1', () => killSubprocesses());
process.on('exit', () => killSubprocesses());