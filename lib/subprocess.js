const subprocesses = [];

/**
 * @returns {void}
 */
export const killSubprocesses = () => {
  for (const proc of subprocesses) {
    proc?.kill?.('SIGTERM');

    setTimeout(() => {
      proc?.kill?.('SIGKILL');
    }, 5000);
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
process.on('SIGKILL', () => killSubprocesses());
process.on('SIGUSR1', () => killSubprocesses());
process.on('exit', () => killSubprocesses());