import path, { basename } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { getRandomValues } from 'node:crypto';
import { Agent, get } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { _appendToFile, _changeInFile, _deleteFromFile, _download, _exec, _unarchive, isVersion } from './utils.js';
import { recordProcess } from './subprocess.js';
import { _error, _info, _notice, _ok, _verbose, _verbose2, _warning } from './logging.js';
import { ARCH, EXTENSION, PLATFORM, tmpDir, TYPE } from './config.js';
import { bcrypt } from 'hash-wasm';

/** Download a release version of OpenSearch
 *
 * @param {string} version
 * @param {boolean} refreshDownloads
 * @returns {Promise<string>}
 */
export const downloadOpenSearch = async (version, refreshDownloads) => {
  const dest = path.join(tmpDir, `opensearch-${version}.${EXTENSION}`);
  if (!refreshDownloads && existsSync(dest)) {
    _verbose2(`Using a previously downloaded ${basename(dest)}`);
    return dest;
  }

  _verbose(`Downloading OpenSearch...`);

  const url = /^1\.[0-2]\./.test(version)
    ? `https://artifacts.opensearch.org/releases/bundle/opensearch/${version}/opensearch-${version}-${PLATFORM}-${ARCH}.${EXTENSION}`
    : `https://ci.opensearch.org/ci/dbc/distribution-build-opensearch/${version}/latest/${PLATFORM}/${ARCH}/${TYPE}/dist/opensearch/opensearch-${version}-${PLATFORM}-${ARCH}.${EXTENSION}`;

  return _download(url, dest);
};

/** Configure certificates for OpenSearch
 * @param {string} folder
 * @returns {Promise<Object>}
 */
export const configureOpenSearchCerts = async (folder) => {
  const configDir = path.join(folder, 'config');
  const dest = path.join(configDir, 'config/certs');

  await rm(dest, { force: true, recursive: true });
  await mkdir(dest, { recursive: true });

  const rooCACert = path.join(dest, 'root-ca.pem');
  const rooCAKey = path.join(dest, 'root-ca-key.pem');
  const adminKeyTemp = path.join(dest, 'admin-key-temp.pem');
  const adminCSR = path.join(dest, 'admin.csr');
  const adminKey = path.join(dest, 'admin-key.pem');
  const adminCert = path.join(dest, 'admin.pem');
  const adminCertSubject = `/C=US/ST=WASHINGTON/L=SEATTLE/O=ORG/OU=UNIT/CN=A`;
  const nodeKeyTemp = path.join(dest, 'node-key-temp.pem');
  const nodeCSR = path.join(dest, 'node.csr');
  const nodeKey = path.join(dest, 'node-key.pem');
  const nodeCert = path.join(dest, 'node.pem');
  const nodeCertSubject = `/C=US/ST=WASHINGTON/L=SEATTLE/O=ORG/OU=UNIT/CN=N`;

  await _exec(`openssl genrsa -out ${rooCAKey} 2048`);
  await _exec(`openssl req -new -x509 -sha256 -key ${rooCAKey} -subj "/C=US/ST=WASHINGTON/L=SEATTLE/O=ORG/OU=UNIT/CN=ROOT" -out ${rooCACert} -days 30`);

  await _exec(`openssl genrsa -out ${adminKeyTemp} 2048`);
  await _exec(`openssl pkcs8 -inform PEM -outform PEM -in ${adminKeyTemp} -topk8 -nocrypt -v1 PBE-SHA1-3DES -out ${adminKey}`);
  await _exec(`openssl req -new -key ${adminKey} -subj "${adminCertSubject}" -out ${adminCSR}`);
  await _exec(`openssl x509 -req -in ${adminCSR} -CA ${rooCACert} -CAkey ${rooCAKey} -CAcreateserial -sha256 -out ${adminCert} -days 30`);

  await _exec(`openssl genrsa -out ${nodeKeyTemp} 2048`);
  await _exec(`openssl pkcs8 -inform PEM -outform PEM -in ${nodeKeyTemp} -topk8 -nocrypt -v1 PBE-SHA1-3DES -out ${nodeKey}`);
  await _exec(`openssl req -new -key ${nodeKey} -subj "${nodeCertSubject}" -out ${nodeCSR}`);
  await _exec(`openssl x509 -req -in ${nodeCSR} -CA ${rooCACert} -CAkey ${rooCAKey} -CAcreateserial -sha256 -out ${nodeCert} -days 30`);

  await Promise.all([rm(adminKeyTemp), rm(adminCSR), rm(nodeKeyTemp), rm(nodeCSR)]);

  return {
    rooCACert: path.relative(configDir, rooCACert),
    rooCAKey: path.relative(configDir, rooCAKey),
    adminKey: path.relative(configDir, adminKey),
    adminCert: path.relative(configDir, adminCert),
    adminCertSubject: adminCertSubject
      .replace(/\//g, ',')
      .replace(/^,+/, ''),
    nodeKey: path.relative(configDir, nodeKey),
    nodeCert: path.relative(configDir, nodeCert),
    nodeCertSubject: nodeCertSubject
      .replace(/\//g, ',')
      .replace(/^,+/, ''),
  };
};

/** Configure OpenSearch
 *
 * @param {string} folder
 * @param {{maps: (string|boolean), mlCommons: (string|boolean), notifications: (string|boolean), observability:
 *   (string|boolean), queryWorkbench: (string|boolean), reporting: (string|boolean), searchRelevance:
 *   (string|boolean), securityAnalytics: (string|boolean), ganttChart: (string|boolean), security: (string|boolean),
 *   plugins: (string|boolean)}} opts
 * @returns {Promise<void>}
 */
export const configureOpenSearch = async (folder, opts) => {
  _verbose(`Configuring OpenSearch in ${folder} ...`);
  const configFile = path.join(folder, 'config/opensearch.yml');
  const certs = await configureOpenSearchCerts(folder);
  await _deleteFromFile(
    configFile,
    ['network.host', 'discovery.type', 'cluster.routing.allocation.disk.threshold_enabled'],
  );

  const configParams = [
    `network.host: ${opts.opensearchHost}`,
    `http.port: ${opts.opensearchPort}`,
    'discovery.type: single-node',
    'cluster.routing.allocation.disk.threshold_enabled: false',
  ];

  if (existsSync(path.join(folder, 'plugins/opensearch-security'))) {
    _verbose(`Configuring OpenSearch security...`);
    configParams.push(
      `plugins.security.ssl.transport.pemcert_filepath: ${certs.nodeCert}`,
      `plugins.security.ssl.transport.pemkey_filepath: ${certs.nodeKey}`,
      `plugins.security.ssl.transport.pemtrustedcas_filepath: ${certs.rooCACert}`,
      `plugins.security.ssl.transport.enforce_hostname_verification: false`,
      `plugins.security.ssl.http.enabled: true`,
      `plugins.security.ssl.http.pemcert_filepath: ${certs.nodeCert}`,
      `plugins.security.ssl.http.pemkey_filepath: ${certs.nodeKey}`,
      `plugins.security.ssl.http.pemtrustedcas_filepath: ${certs.rooCACert}`,
      `plugins.security.allow_default_init_securityindex: true`,
      `plugins.security.authcz.admin_dn:`,
      `  - '${certs.adminCertSubject}'`,
      `plugins.security.nodes_dn:`,
      `  - '${certs.nodeCertSubject}'`,
      `plugins.security.audit.type: internal_opensearch`,
      `plugins.security.enable_snapshot_restore_privilege: true`,
      `plugins.security.check_snapshot_restore_write_privileges: true`,
      `plugins.security.restapi.roles_enabled: ["all_access", "security_rest_api_access"]`,
    );

    if (opts.security !== true) {
      configParams.push(`plugins.security.disabled: true`);
    } else {
      const securityConfigDir = path.join(folder, 'config', 'opensearch-security');
      const hash = await bcrypt({
        password: opts.password,
        salt: getRandomValues(new Uint8Array(16)),
        costFactor: 12,
        version: '2y',
        outputType: 'encoded',
      });

      await mkdir(securityConfigDir, { recursive: true });
      await writeFile(
        path.join(securityConfigDir, 'internal_users.yml'),
        '---\n' +
        '_meta:\n' +
        '  type: "internalusers"\n' +
        '  config_version: 2\n\n' +
        'admin:\n' +
        `  hash: "${hash}"\n` +
        '  reserved: true\n' +
        '  backend_roles:\n' +
        '  - "admin"\n' +
        '  description: "Admin user"\n',
      );

      await _changeInFile(path.join(securityConfigDir, 'config.yml'), {
        'dynamic:': `  dynamic:\n    kibana:\n      server_username: "${opts.username}"`
      });
    }
  }

  if (existsSync(path.join(folder, 'plugins/opensearch-index-management'))) {
    configParams.push(`path.repo: [${os.tmpdir()}]`);
  }

  if (existsSync(path.join(folder, 'plugins/opensearch-alerting'))) {
    configParams.push('plugins.destination.host.deny_list: ["10.0.0.0/8", "127.0.0.1"]');
  }

  if (existsSync(path.join(folder, 'plugins/opensearch-sql'))) {
    configParams.push('script.context.field.max_compilations_rate: 1000/1m');
  }

  if (existsSync(path.join(folder, 'plugins/opensearch-performance-analyzer'))) {
    const paPropsFile = path.join(folder, 'config/opensearch-performance-analyzer/performance-analyzer.properties');
    if (existsSync(paPropsFile)) {
      await _appendToFile(paPropsFile, 'webservice-bind-host = 0.0.0.0');
    } else {
      await mkdir(path.join(folder, 'config/opensearch-performance-analyzer'), { recursive: true });
      await writeFile(paPropsFile, 'webservice-bind-host = 0.0.0.0', 'utf8');
    }
  }

  await _appendToFile(configFile, configParams);

  /* ToDo: Expose to CLI
  const totalMemory = os.totalmem() / (1024 * 1024 * 1024);
  // Giving JVM 50% of the RAM
  const jvmMemory = Math.max(Math.floor(totalMemory / 2), 4);

  _notice(`Configuring OpenSearch to use ${jvmMemory}GB of memory`);
  await _changeInFile(path.join(folder, 'config/jvm.options'), {
    '-Xms1g': `-Xms${jvmMemory}g`,
    '-Xmx1g': `-Xmx${jvmMemory}g`,
  });
   */
};

/** Check OpenSearch health
 * @returns {Promise<boolean|undefined>}
 */
export const checkOpenSearchHealth = async (opts) => {
  try {
    let status;
    if (opts.security === true) {
      const agent = new Agent({
        rejectUnauthorized: false,
      });

      const json = await new Promise((resolve, reject) => {
        get(`https://${opts.opensearchHost}:${opts.opensearchPort}/_cluster/health`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`,
          }, agent,
        }, response => {
          if (response.statusCode !== 200) return reject(response.statusCode);

          const contentType = response.headers?.['content-type'];
          if (!contentType?.includes('application/json')) return reject(contentType);

          const content = [];
          response.on('data', chunk => content.push(chunk));
          response.on('end', () => resolve(JSON.parse(content.join(''))));
        }).on('error', err => {
          reject(err);
        });
      });

      status = json?.status;
    } else {
      const response = await fetch(`http://${opts.opensearchHost}:${opts.opensearchPort}/_cluster/health`);

      const contentType = response?.headers?.get?.('content-type');
      if (!contentType.includes('application/json')) return;

      const json = await response.json();
      status = json?.status;
    }

    if (['green', 'yellow'].includes(status)) {
      _ok(`\n\nOpenSearch is ${status}\n`);
      return true;
    }

    _error(`\n\nOpenSearch is ${status}\n`);
    return false;
  } catch (ex) {
  }
};

/** Run OpenSearch
 *
 * @param {string} folder
 * @param {number} timeoutSeconds
 * @returns {Promise<ChildProcess|undefined>}
 */
export const runOpenSearch = async (folder, timeoutSeconds, opts) => {
  let closed = false;
  let running = false;
  const executable = process.platform === 'win32' ? 'opensearch.bat' : 'opensearch';
  const child = spawn(path.join(folder, 'bin', executable), {
    cwd: folder, stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
    .on('close', code => {
      if (!running) {
        closed = true;
        _error(`\n\nOpenSearch closed with ${code}.\n`);
      }
    });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const timerStart = Date.now();
  do {
    const tryStart = Date.now();
    if (await checkOpenSearchHealth(opts)) {
      running = true;
      child.stdout.unpipe(process.stdout);
      child.stderr.unpipe(process.stderr);
      recordProcess(child);
      return child;
    }

    if (closed || Date.now() - timerStart > timeoutSeconds * 1e3) {
      child.kill('SIGTERM');
      child.unref();
      _error(`\n\nTimeout waiting for OpenSearch to stabilize\n`);
      return;
    }

    _notice(`\n\nWaiting for OpenSearch to stabilize (${Math.floor((timeoutSeconds * 1e3 - Date.now() + timerStart) / 1e3)}s)\n`);
    await setTimeout(5000 - Date.now() + tryStart);
  } while (true);
};

/** Prepare OpenSearch
 * @param {Object} args
 * @param {string} args.destination
 * @param {string} args.opensearchVersion
 * @param {boolean} args.refreshDownloads
 * @param {{maps: (string|boolean), mlCommons: (string|boolean), notifications: (string|boolean), observability:
 *   (string|boolean), queryWorkbench: (string|boolean), reporting: (string|boolean), searchRelevance:
 *   (string|boolean), securityAnalytics: (string|boolean), ganttChart: (string|boolean), security: (string|boolean),
 *   plugins: (string|boolean)}} opts
 * @returns {Promise<string|undefined>}
 */
export const prepareOpenSearch = async ({ destination, opensearchVersion, refreshDownloads, ...opts }) => {
  if (!isVersion(opensearchVersion)) {
    _warning(`Skipped preparing OpenSearch as no version was specified!`);
    return;
  }

  _info(`Preparing OpenSearch v${opensearchVersion}...`);

  const startTime = Date.now();
  const osDir = path.join(destination, `OpenSearch-v${opensearchVersion}`);
  const archive = await downloadOpenSearch(opensearchVersion, refreshDownloads);

  try {
    _unarchive(archive, osDir);
  } catch (ex) {
    throw `The downloaded OpenSearch artifact appears to have been corrupted. Re-run the program with '--refresh-downloads' to download a fresh copy.`;
  }

  await configureOpenSearch(osDir, opts);

  _ok(`OpenSearch took ${Math.round((Date.now() - startTime) / 1000)}s to prepare.`);

  return osDir;
};