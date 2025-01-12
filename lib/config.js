import { parse } from 'json11';
import fs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configRoot = join(__dirname, '../config');
const configStore = {};

export const tmpDir = path.join(os.homedir(), '.osd-launcher');
export const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
export const EXTENSION = process.platform === 'win32' ? 'zip' : 'tar.gz';
export const TYPE = process.platform === 'win32' ? 'zip' : 'tar';
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

const deepFreeze = obj => {
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = obj[name];
    if (value && typeof value === 'object') deepFreeze(value);
  }

  return Object.freeze(obj);
};

const deepMerge = (target, source) => {
  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return target;
};

const deepExpand = obj => {
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const keys = name?.split?.('.')?.filter?.(el => el);
    const value = isObject(obj[name]) ? deepExpand(obj[name]) : obj[name];
    if (keys?.length > 1) {
      delete obj[name];
      const o = {};
      const lastKey = keys.pop();
      let node = o;
      for (const key of keys) {
        Object.assign(node, { [key]: {} });
        node = node[key];
      }
      Object.assign(node, { [lastKey]: value });
      deepMerge(obj, o);
    } else {
      Object.assign(obj, { [name]: value });
    }
  }

  return obj;
};

const getConfig = prop => {
  const keys = (Array.isArray(prop) ? prop : prop?.split?.('.'))?.filter?.(el => el);
  let config = configStore;
  for (let i = 0, len = keys.length; i < len; i++) {
    config = config[keys[i]];
    if (config === undefined) break;
  }

  return config;
};

const processDir = dir => {
  const config = {};
  const names = fs.readdirSync(dir);
  for (let i = 0, len = names.length; i < len; i++) {
    const resolvedPath = join(dir, names[i]);
    const baseName = basename(names[i]).replace(/\.json5?$/i, '');
    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      config[baseName] = processDir(resolvedPath);
    } else if (/\.json5?$/i.test(names[i])) {
      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8')?.replace?.(/^\uFEFF/, '');
        config[baseName] = parse(content);
      } catch (ex) {
        console.error(ex);
      }
    }
  }

  return config;
};

Object.assign(configStore, deepExpand(processDir(configRoot)));

deepFreeze(configStore);

export { getConfig as get };