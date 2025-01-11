#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { get } from './lib/config.js';
import { program, Option, InvalidArgumentError } from 'commander';
import { _error, _ok, _verbose2, _warning } from './lib/logging.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenSearch, runOpenSearch } from './lib/opensearch.js';
import { prepareDashboards, runDashboards } from './lib/dashboards.js';
import { camelCase, isGitHubSource, isVersion } from './lib/utils.js';
import { killSubprocesses } from './lib/subprocess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: pkgVersion } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

const projects = get('projects');

const pluginSlugs = [];
const pluginDisplays = [];
for (const { slug, name } of projects) {
  if (slug === 'dashboards') continue;

  program.addOption(
    new Option(`--${slug}-source <repo>`, `${name} plugin source to use`)
      .implies({ [camelCase(`${slug}`)]: true })
      .hideHelp(),
  );
  if (slug !== 'security') {
    program.addOption(
      new Option(`--no-${slug}`, `Prevent the inclusion of ${name} Dashboards plugin`)
        .hideHelp(),
    );
  }

  pluginSlugs.push(slug);
  pluginDisplays.push(slug.padEnd(24, ' ') + name);
}

const fullVersion = input => {
  const value = input?.trim?.();
  if (isVersion(value)) return value;

  throw new InvalidArgumentError('The value needs to be a complete version (e.g. 2.15.0).');
};

const gitOrVersionOrDirectory = input => {
  const value = input?.trim?.();
  if (isVersion(value)) return value;
  if (isGitHubSource(value)) return value;
  if (existsSync(value)) return value;

  if (/[:\/]/.test(value))
    throw new InvalidArgumentError(
      'The value needs to be a complete version (e.g. 2.15.0) or in the form of github:user/repo/branch.');

  return `github://${value}`;
};

const resolveDestination = value => {
  const destination = value?.trim?.();
  return resolve(destination);
};

program
  .name('osd-launcher')
  .description('CLI to ease the setup of OpenSearch and Dashboards')
  .option('-os, --opensearch-version <version>', 'OpenSearch version to use', fullVersion)
  .option(
    '-osd, --dashboards-version <version|repo|directory>',
    'Dashboards version to use\n<version>: use a released version\n<repo>: clone a git repo/branch/commit\n<directory>: configure and use existing code',
    gitOrVersionOrDirectory,
  )
  .option(
    '-d, --destination <path>',
    'Location for deploying',
    resolveDestination,
    process.cwd(),
  )
  .option('--no-plugins', 'Prevent installation of Dashboards plugins')
  .addOption(
    new Option('--no-security', 'Disable the Security plugins in OpenSearch and Dashboards')
      .conflicts(['securityVersion'])
      .argParser((value, previous) => {
        const options = program.opts();
        if (options.password) {
          throw new InvalidArgumentError('Password cannot be set when security is disabled (--no-security).');
        }
        return value;
      })
  )
  .option('--refresh-downloads', 'Re-download artifacts even if they are available in cache')
  .option(
    '--opensearch-host <hostname|IP>',
    'Hostname or IP address for OpenSearch to listen on',
    '127.0.0.1',
  )
  .option('--opensearch-port <number>', 'Port number for OpenSearch to listen on', '9200')
  .option(
    '--dashboards-host <hostname|IP>',
    'Hostname or IP address for OpenSearch to listen on',
    '0.0.0.0',
  )
  .option('--dashboards-port <number>', 'Port number for OpenSearch to listen on', '5601')
  .option('-u, --username <username>', 'Username to use if security is enable', 'admin')
  .addOption(
    new Option('-p, --password <password>', 'Password to use if security is enabled')
      .argParser((value, previous) => {
        const options = program.opts();
        if (options.security !== true) {
          throw new InvalidArgumentError('Password cannot be set when security is disabled (--no-security).');
        }
        return value;
      })
  )
  .option('-dev --no-build', 'Skip building Dashboards when cloned')
  // ToDo: Add ability to start installations as a service
  //.option('--add-service', 'Create services for OpenSearch and Dashboards')
  .version(pkgVersion, '-v, --version', 'Print launcher version')
  .showHelpAfterError();

program.addHelpText('after', `
Fine-tuning Dashboards plugins:
  The version of Dashboards plugins can be specified using --<name>-source <repo>.
  The inclusion of a plugin can be prevented using --no-<name>.
  
  Supported plugin names are: 
    ${pluginDisplays.join('\n    ')}
  
  If a specific release version of Dashboards is requested, the plugins included with the
  release will be installed and the fine-tuned source parameters have no effect.
   
  Installing Dashboards from a GitHub source, if no plugin-specific source is requested, the
  plugins will be cloned from the official sources.
  
<version> format:
  A complete release version includes all 3 components of a semantic version. e.g. 2.15.0
  
<repo> format:
  A GitHub source starts with "github:" and includes all 3 names of the use, the repository
  and the branch:
    github:opensearch-project/opensearch-dashboards/awesome-feature
    
  A shorthand alternative is also supported to use a branch from the official repositories:
    github://2.x
    
  If Dashboards is cloned from a numeric branch name (e.g. 2.15 and 2.x), the plugins will
  be cloned from the matching branch of the official sources, unless a specific source is
  requested for them. 
`);

program.parse();

const run = async () => {
  const opts = program.opts();
  if (opts.plugins !== true) {
    opts.plugins = false;
    for (const slug of pluginSlugs)
      if (slug !== 'security' && !opts[camelCase(`${slug}-source`)])
        opts[camelCase(slug)] = false;
  }
  if (isVersion(opts.dashboardsVersion)) opts.build = false;

  console.log(opts);

  const osDir = await prepareOpenSearch(opts);
  const osdDir = await prepareDashboards(opts);

  let osChild, osdChild;

  if (osDir) {
    osChild = await runOpenSearch(osDir, 180, opts);
    if (!osChild) throw `Failed to run OpenSearch`;
  }

  if (osdDir) {
    if (osDir && !osChild) {
      _warning(`Skipping Dashboards health-check!`);
    } else {
      osdChild = await runDashboards(osdDir, opts.build ? 1800 : 600, opts);
      if (!osdChild) throw `Failed to run OpenSearch Dashboards`;
    }
  }

  if (osDir && osdDir) {
    if (osChild && osdChild)
      _ok(`OpenSearch and Dashboards installed successfully.`);
  } else if (osdDir && osdChild)
    _ok(`Dashboards installed successfully.`);
  else if (osDir && osChild)
    _ok(`OpenSearch installed successfully.`);

  killSubprocesses();

  if (osDir && osChild)
    _verbose2(`OpenSearch: http${opts.security === true ? 's' : ''}://${opts.opensearchHost}:${opts.opensearchPort}`);
  if (osdDir && osdChild)
    _verbose2('Dashboards: http://${opts.dashboardsHost}:${opts.dashboardsPort}');
};

run().catch(err => {
  _error('Error:', err);
  process.exit(1);
});