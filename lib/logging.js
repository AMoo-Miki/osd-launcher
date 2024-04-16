import chalk from 'chalk';

export const _info = (...args) => {
  console.log.apply(null, args.map(l => chalk.cyan(l)));
};

export const _ok = (...args) => {
  console.log.apply(null, args.map(l => chalk.green(l)));
};

export const _verbose = (...args) => {
  console.log.apply(null, args.map(l => chalk.gray(l)));
};
export const _verbose2 = (...args) => {
  console.log.apply(null, args.map(l => chalk.white(l)));
};

export const _notice = (...args) => {
  console.log.apply(null, args.map(l => chalk.magenta(l)));
};

export const _warning = (...args) => {
  console.log.apply(null, args.map(l => chalk.yellow(l)));
};

export const _error = (...args) => {
  console.log.apply(null, args.map(l => chalk.red(l)));
};