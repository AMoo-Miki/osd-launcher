const subprocesses = [];

/**
 * @returns {void}
 */
export const killSubprocesses = () => {
  for (const proc of subprocesses)
    proc?.kill?.('SIGTERM');
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