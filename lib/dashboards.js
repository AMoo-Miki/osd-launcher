import path, { basename } from 'node:path';
import { copyFile, readdir, readFile, rename, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import {
  _appendToFile,
  _changeInFile,
  _deleteFromFile,
  _download,
  _exec,
  _spawn,
  _unarchive,
  camelCase,
  isGitHubSource,
  isVersion,
} from './utils.js';
import { recordProcess } from './subprocess.js';
import { _error, _info, _notice, _ok, _verbose, _verbose2, _warning } from './logging.js';
import { ARCH, EXTENSION, get, PLATFORM, tmpDir, TYPE } from './config.js';

const projects = get('projects');
const projectSlugs = {};
const dashboardsPlugins = [];
for (const { slug, name, src, releaseName } of projects) {
  projectSlugs[slug] = { slug, name, src, releaseName };
  if (slug !== 'dashboards') dashboardsPlugins.push({
    slug, name, src, releaseName, optionName: camelCase(slug), optionSource: camelCase(`${slug}-source`),
  });
}

/** Download a release version of Dashboards
 *
 * @param {string} version
 * @param {boolean} refreshDownloads
 * @returns {Promise<string>}
 */
export const downloadDashboards = async (version, refreshDownloads) => {
  const dest = path.join(tmpDir, `dashboards-${version}.${EXTENSION}`);
  if (!refreshDownloads && existsSync(dest)) {
    _verbose2(`Using a previously downloaded ${basename(dest)}`);
    return dest;
  }

  const url = /^1\.[0-2]\./.test(version)
    ? `https://artifacts.opensearch.org/releases/bundle/opensearch-dashboards/${version}/opensearch-dashboards-${version}-${PLATFORM}-${ARCH}.${EXTENSION}`
    : `https://ci.opensearch.org/ci/dbc/distribution-build-opensearch-dashboards/${version}/latest/${PLATFORM}/${ARCH}/${TYPE}/dist/opensearch-dashboards/opensearch-dashboards-${version}-${PLATFORM}-${ARCH}.${EXTENSION}`;

  return _download(url, dest);
};

const getSource = (slug, requestedSource, osdBranch) => {
  if (!projectSlugs[slug]) throw `Unknown key: ${slug}`;
  const source = requestedSource?.trim?.().replace(/^github:(\/\/)?/i, '');
  if (source) {
    const [user, repo, branch] = source.split('/');

    if (user && repo && branch)
      return { user, repo, branch };

    if (user && repo === undefined && branch === undefined)
      return getOfficialSource(slug, branch);
  } else if (osdBranch)
    return getOfficialSource(slug, osdBranch);
  else
    return getOfficialSource(slug);

  throw `Failed to find a source for ${projectSlugs[slug].name} using ${requestedSource} or ${osdBranch}.`;
};

const getOfficialSource = (slug, requestedBranch) => {
  if (!projectSlugs[slug]) throw `Unknown key: ${slug}`;
  const [user, repo, branch] =
    projectSlugs[slug]
      .src
      // src stored in config has to be a complete 3-part reference
      .replace(/^github:/i, '')
      .split('/');

  return { user, repo, branch: requestedBranch || branch };
};

/** Download a GitHub version of Dashboards
 *
 * @param {string} source
 * @param {Object} opts
 * @returns {Promise<string>}
 */
export const cloneDashboards = async (source, opts) => {
  const dest = path.join(tmpDir, 'dashboards-' + source.replace(/[^a-z0-9.\-]+/ig, '-'));
  await rm(dest, { force: true, recursive: true });

  const { user, repo, branch } = getSource('dashboards', source);
  const dashboardsBranch = /^\d+\.(x|\d+)$/.test(branch) ? branch : undefined;

  _info(`Cloning Dashboards from github:${user}/${repo}/${branch}`);
  await _spawn(`git clone https://github.com/${user}/${repo}.git --depth 1 --branch ${branch} -- ${dest}`);

  for (const { optionName, optionSource, name, slug } of dashboardsPlugins) {
    if (opts[optionName] !== true) continue;

    const source = getSource(slug, opts[optionSource], dashboardsBranch);
    _info(`Cloning ${name} from git://${source.user}/${source.repo}/${source.branch}`);
    const pluginDest = path.join(dest, 'plugins', slug);
    await _spawn(`git clone https://github.com/${source.user}/${source.repo}.git --depth 1 --branch ${source.branch} -- ${pluginDest}`);
  }

  return dest;
};

/** Download a GitHub version of Plugins
 *
 * @param {string} dest
 * @param {Object} opts
 * @returns {Promise<string>}
 */
export const clonePlugins = async (dest, opts) => {
  _info(`Using Dashboards from ${dest}`);

  const pluginDir = path.join(dest, 'plugins');

  await rm(pluginDir, { force: true, recursive: true });
  await mkdir(pluginDir, { recursive: true });

  for (const { optionName, optionSource, name, slug } of dashboardsPlugins) {
    if (opts[optionName] !== true) continue;

    const source = getSource(slug, opts[optionSource]);
    _info(`Cloning ${name} from git://${source.user}/${source.repo}/${source.branch}`);
    const pluginDest = path.join(pluginDir, slug);
    await _spawn(`git clone https://github.com/${source.user}/${source.repo}.git --depth 1 --branch ${source.branch} -- ${pluginDest}`);
  }

  return dest;
};

/** Build plugin
 * @param {string} name
 * @param {string} pluginsDir
 * @param {string} pluginBuildDestDir
 */
export const buildPlugin = async (name, pluginsDir, pluginBuildDestDir) => {
  const pluginFolder = path.join(pluginsDir, name);
  _info(`Building plugin in ${pluginFolder}`);
  await _exec(`node ../../scripts/plugin_helpers.js build --skip-archive`, { cwd: pluginFolder });
  const pluginBuildDir = path.join(pluginsDir, name, 'build/opensearch-dashboards');
  const pluginBuiltContent = await readdir(pluginBuildDir, { withFileTypes: true, encoding: 'utf8' });
  for (const pluginBuiltItem of pluginBuiltContent) {
    if (pluginBuiltItem.isDirectory()) {
      await rename(
        path.join(pluginBuildDir, pluginBuiltItem.name),
        path.join(pluginBuildDestDir, pluginBuiltItem.name),
      );
    }
  }
};

/** Build Dashboards and plugins
 *
 * @param {string} folder
 * @param {Object} opts
 * @returns {Promise<string>} Build directory location
 */
export const buildDashboards = async (folder, opts) => {
  _info(`Building Dashboards in ${folder}`);

  const buildVersion = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')).version;

  _verbose(`Bootstrapping Dashboards without plugins in ${folder}`);
  await _spawn('yarn osd bootstrap --single-version=loose --skip-opensearch-dashboards-plugins', {
    cwd: folder, maxBuffer: 100 * 1024 * 1024,
  });

  const pluginsDir = path.join(folder, 'plugins');
  const pluginContent = await readdir(pluginsDir, { withFileTypes: true, encoding: 'utf8' });

  _verbose(`Overriding Dashboards plugins' versions...`);
  for (const item of pluginContent) {
    if (item.isDirectory()) {
      await _exec(
        `node ../../scripts/plugin_helpers.js version --sync legacy`,
        { cwd: path.join(pluginsDir, item.name) },
      );
    }
  }

  _verbose(`Bootstrapping Dashboards...`);
  await _spawn('yarn osd bootstrap --single-version=loose', { cwd: folder, maxBuffer: 100 * 1024 * 1024 });

  if (opts.build !== true) return folder;

  _info(`Building release artifacts for Dashboards...`);
  const buildType = '--' + PLATFORM + (process.platform !== 'win32' && process.arch === 'arm64' ? '-arm' : '');
  await _spawn(`yarn build-platform ${buildType} --release --skip-archives --skip-os-packages`, { cwd: folder });

  const buildDir = path.join(folder, 'build', `opensearch-dashboards-${buildVersion}-${PLATFORM}-${process.arch}`);
  const pluginBuildDestDir = path.join(buildDir, 'plugins');

  const pluginBuilds = [];
  for (const item of pluginContent) {
    if (item.isDirectory()) {
      pluginBuilds.push(buildPlugin(item.name, pluginsDir, pluginBuildDestDir));

    }
  }

  await Promise.all(pluginBuilds);

  return buildDir;
};

/** Patch Dashboards plugins
 *
 * @param {string} folder
 */
export const patchDashboardsPlugins = async (folder) => {
  if (existsSync(path.join(folder, 'plugins/maps/package.json'))) {
    // maps: @opensearch-dashboards-test/opensearch-dashboards-test-library
    await _deleteFromFile(
      path.join(folder, 'plugins/maps/package.json'),
      '"@opensearch-dashboards-test/opensearch-dashboards-test-library":',
    );
  }
  if (existsSync(path.join(folder, 'plugins/reporting/package.json'))) {
    // reporting: jsdom
    await _deleteFromFile(path.join(folder, 'plugins/reporting/package.json'), '"jsdom":');
  }
  // osd
  await _changeInFile(path.join(folder, 'src/dev/build/tasks/build_opensearch_dashboards_platform_plugins.ts'), {
    'import { REPO_ROOT } from \'@osd/utils\';': 'import { resolve } from "path";import { REPO_ROOT } from \'@osd/utils\';\n',
    'repoRoot: REPO_ROOT,': 'repoRoot: REPO_ROOT,pluginScanDirs: [resolve(REPO_ROOT, "src/plugins")],',
  });
};

/** Patch test for code coverage
 *
 * @param {string} folder
 */
export const patchTestCodeOverage = async (folder) => {
  if (1) return _notice(`Skipping code coverage patching in ${folder}`);

  await _changeInFile(path.join(folder, 'package.json'), {
    '"devDependencies":': `"devDependencies": {\n"babel-plugin-istanbul": "^6.1.1",\n"@cypress/code-coverage": "^3.12.28",\n"nyc": "^15.1.0",\n"istanbul-lib-coverage": "^3.2.2",`,
  });
};

/** Patch Dashboards to ignore version mismatch
 *
 * @param {string} folder
 * @param {Object} opts
 * @returns {Promise<void>}
 */
export const patchDashboardsIgnoreVersionMismatch = async (folder, opts) => {
  await _deleteFromFile(
    path.join(folder,
      `src/core/server/opensearch/opensearch_config.${(isVersion(opts.dashboardsVersion) || opts.build === true)
        ? 'js'
        : 'ts'}`,
    ),
    '"ignoreVersionMismatch" can only be set to true in development mode',
  );
};

/** Patch Dashboards binary files
 *
 * @param {string} folder
 * @param {Object} opts
 * @returns {Promise<void>}
 */
export const patchDashboardsBinary = async (folder, opts) => {
  if (!opts.build) return;
  await copyFile(
    path.join(folder, 'bin/opensearch-dashboards' + (process.platform === 'win32' ? '.bat' : '')),
    path.join(folder, 'bin/opensearch_dashboards' + (process.platform === 'win32' ? '.bat' : '')),
  );
};

/** Configure Dashboards
 *
 * @param {string} folder
 * @param {Object} opts
 * @returns {Promise<void>}
 */
export const configureDashboards = async (folder, opts) => {
  const configFile = path.join(folder, 'config/opensearch_dashboards.yml');

  const linesToDelete = [
    'server.host',
    'server.port',
    'opensearch.ssl.verificationMode',
    'opensearch.ignoreVersionMismatch',
    'savedObjects.maxImportPayloadBytes',
    'server.maxPayloadBytes',
    'logging.json',
    'data.search.aggs.shardDelay.enabled',
    'csp.warnLegacyBrowsers',
    'opensearch.hosts',
    'opensearch.username',
    'opensearch.password',
  ];
  if (opts.security !== true) linesToDelete.push('opensearch_security.');

  await _deleteFromFile(configFile, linesToDelete);

  const configParams = [
    `server.host: ${opts.dashboardsHost}`,
    `server.port: ${opts.dashboardsPort}`,
    'opensearch.ssl.verificationMode: none',
    'opensearch.ignoreVersionMismatch: true',
    'savedObjects.maxImportPayloadBytes: 10485760',
    'server.maxPayloadBytes: 1759977',
    'logging.json: false',
    'data.search.aggs.shardDelay.enabled: true',
    'csp.warnLegacyBrowsers: false',
  ];

  if (opts.security === true) {
    configParams.push(
      `opensearch.hosts: ["https://${opts.opensearchHost}:${opts.opensearchPort}"]`,
      `opensearch.username: "${opts.username}"`,
      `opensearch.password: "${opts.password}"`,
    );
  } else {
    configParams.push(`opensearch.hosts: ["http://${opts.opensearchHost}:${opts.opensearchPort}"]`);
    await rm(path.join(folder, 'plugins/securityDashboards'), { force: true, recursive: true });
  }

  await _appendToFile(configFile, configParams);
};

/** Check Dashboards health
 *
 * @returns {Promise<boolean|undefined>}
 */
export const checkDashboardsHealth = async (opts) => {
  try {
    const fetchParams = opts.security === true ? {
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`,
      },
    } : {};
    const response = await fetch(`http://${opts.dashboardsHost}:${opts.dashboardsPort}/api/status`, fetchParams);
    const contentType = response?.headers?.get?.('content-type');
    if (!contentType.includes('application/json')) return;

    const json = await response.json();
    if (json?.status?.overall?.state === 'green') {
      _ok(`\n\nDashboards is ${json?.status?.overall?.state}\n`);
    } else {
      _error(`\n\nDashboards is ${json?.status?.overall?.state}\n`);
    }

    return json?.status?.overall?.state === 'green';
  } catch (ex) {
  }
};

/** Run Dashboards
 *
 * @param {string} folder
 * @param {number} timeoutSeconds
 * @param {Object} opts
 * @returns {Promise<ChildProcess|undefined>}
 */
export const runDashboards = async (folder, timeoutSeconds, opts) => {
  let closed = false;
  let running = false;
  const spawnArgs = [];
  let spawnCmd;
  if (isVersion(opts.dashboardsVersion) || opts.build === true) {
    const executable = process.platform === 'win32' ? 'opensearch-dashboards.bat' : 'opensearch-dashboards';
    spawnCmd = path.join(folder, 'bin', executable);
  } else {
    spawnCmd = 'yarn';
    spawnArgs.push('start', '--no-base-path');
  }

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: folder, stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
    .on('close', code => {
      if (!running) {
        closed = true;
        _error(`\n\nDashboards closed with ${code}.\n`);
      }
    });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const timerStart = Date.now();
  do {
    const tryStart = Date.now();
    if (await checkDashboardsHealth(opts)) {
      running = true;
      child.stdout.unpipe(process.stdout);
      child.stderr.unpipe(process.stderr);
      recordProcess(child);
      return child;
    }

    if (closed || Date.now() - timerStart > timeoutSeconds * 1e3) {
      child.kill('SIGTERM');
      child.unref();
      return;
    }

    _notice(`\n\nWaiting for Dashboards to stabilize (${Math.floor((timeoutSeconds * 1e3 - Date.now() + timerStart) / 1e3)}s)\n`);
    await setTimeout(5000 - Date.now() + tryStart);
  } while (true);
};

/** Prepare Dashboards
 *
 * @returns {Promise<string|undefined>}
 */
export const prepareDashboards = async opts => {
  const { destination, dashboardsVersion, refreshDownloads } = opts;

  let dirSuffix;
  let useExisting;
  if (isVersion(dashboardsVersion)) {
    dirSuffix = `v${dashboardsVersion}`;
  } else if (isGitHubSource(dashboardsVersion)) {
    dirSuffix = dashboardsVersion
      .replace(/^github:(\/\/)?/i, '')
      .replace(/[^a-z0-9.\-]+/ig, '-')
      .toLowerCase();
  } else if (existsSync(dashboardsVersion)) {
    useExisting = path.resolve(dashboardsVersion);
  } else {
    _warning(`Skipped preparing Dashboards as no version or source was specified!`);
    return;
  }

  _info(`Preparing Dashboards ...`);

  const startTime = Date.now();
  const osdDir = (useExisting && opts.build !== true) ? useExisting : path.join(destination, `Dashboards-${dirSuffix}`);

  if (isVersion(dashboardsVersion)) {
    const archive = await downloadDashboards(dashboardsVersion, refreshDownloads);

    try {
      _unarchive(archive, osdDir);
    } catch (ex) {
      throw `The downloaded Dashboards artifact appears to have been corrupted. Re-run the program with '--refresh-downloads' to download a fresh copy.`;
    }

    for (const { optionName, releaseName, slug } of dashboardsPlugins) {
      if (opts[optionName] !== true) {
        const pluginDir = path.join(osdDir, 'plugins', releaseName || camelCase(`${slug}-dashboards`));
        _verbose(`Removing plugin artifacts from ${pluginDir}...`);
        await rm(pluginDir, { recursive: true, force: true });
      }
    }
  } else if (useExisting) {
    await clonePlugins(useExisting, opts);
    await patchDashboardsPlugins(useExisting);
    const buildDir = await buildDashboards(useExisting, opts);

    if (opts.build === true) {
      await rm(osdDir, { force: true, recursive: true });
      await rename(buildDir, osdDir);
    }
  } else {
    const gitDir = await cloneDashboards(dashboardsVersion, opts);
    await patchDashboardsPlugins(gitDir);

    const buildDir = await buildDashboards(gitDir, opts);
    await rm(osdDir, { force: true, recursive: true });
    await rename(buildDir, osdDir);
  }

  await configureDashboards(osdDir, opts);
  await patchDashboardsBinary(osdDir, opts);
  await patchDashboardsIgnoreVersionMismatch(osdDir, opts);

  _ok(`Dashboards took ${Math.round((Date.now() - startTime) / 1000)}s to prepare.`);

  return osdDir;
};