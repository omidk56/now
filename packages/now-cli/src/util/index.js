import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import EventEmitter from 'events';
import qs from 'querystring';
import { parse as parseUrl } from 'url';
import bytes from 'bytes';
import chalk from 'chalk';
import retry from 'async-retry';
import { parse as parseIni } from 'ini';
import fs from 'fs-extra';
import ms from 'ms';
import { URLSearchParams } from 'url';
import { createDeployment, createLegacyDeployment } from 'now-client'
import {
  staticFiles as getFiles,
  npm as getNpmFiles,
  docker as getDockerFiles
} from './get-files';
import Agent from './agent.ts';
import ua from './ua.ts';
import highlight from './output/highlight';
import createOutput from './output';
import wait from './output/wait';
import { responseError } from './error';
import stamp from './output/stamp';

// Check if running windows
const IS_WIN = process.platform.startsWith('win');
const SEP = IS_WIN ? '\\' : '/';

export default class Now extends EventEmitter {
  constructor({ apiUrl, token, currentTeam, forceNew = false, debug = false }) {
    super();

    this._token = token;
    this._debug = debug;
    this._forceNew = forceNew;
    this._output = createOutput({ debug });
    this._apiUrl = apiUrl;
    this._agent = new Agent(apiUrl, { debug });
    this._onRetry = this._onRetry.bind(this);
    this.currentTeam = currentTeam;
    const closeAgent = () => {
      this._agent.close();
      process.removeListener('nowExit', closeAgent);
    };
    process.on('nowExit', closeAgent);
  }

  async create(
    paths,
    {
      // Legacy
      forwardNpm = false,
      scale = {},
      description,
      type = 'npm',
      pkg = {},
      nowConfig = {},
      hasNowJson = false,
      sessionAffinity = 'random',
      isFile = false,
      atlas = false,

      // Latest
      name,
      project,
      wantsPublic,
      meta,
      regions,
      quiet = false,
      env,
      build,
      forceNew = false,
      target = null
    }
  ) {
    const opts = { output: this._output, hasNowJson };
    const { log, warn, debug } = this._output;
    const isBuilds = type === null;

    let files = [];
    let hashes = {};
    const relatives = {};
    let engines;
    let deployment;
    let requestBody = {}

    if (isBuilds) {
      requestBody = {
        token: this._token,
        teamId: this.currentTeam,
        env,
        build,
        public: wantsPublic || nowConfig.public,
        name,
        project,
        meta,
        regions,
        force: forceNew,
      }

      if (target) {
        requestBody.target = target;
      }

      if (isFile) {
        requestBody.routes = [
          {
            src: '/',
            dest: `/${files[0].file}`
          }
        ];
      }
    } else if (type === 'npm') {
      files = await getNpmFiles(paths[0], pkg, nowConfig, opts);

      // A `start` or `now-start` npm script, or a `server.js` file
      // in the root directory of the deployment are required
      if (
        !isBuilds &&
        !hasNpmStart(pkg) &&
        !hasFile(paths[0], files, 'server.js')
      ) {
        const err = new Error(
          'Missing `start` (or `now-start`) script in `package.json`. ' +
            'See: https://docs.npmjs.com/cli/start'
        );
        throw err;
      }

      engines = nowConfig.engines || pkg.engines;
      forwardNpm = forwardNpm || nowConfig.forwardNpm;
    } else if (type === 'static') {
      if (isFile) {
        files = [resolvePath(paths[0])];
      } else if (paths.length === 1) {
        files = await getFiles(paths[0], nowConfig, opts);
      } else {
        if (!files) {
          files = [];
        }

        for (const path of paths) {
          const list = await getFiles(path, {}, opts);
          files = files.concat(list);

          for (const file of list) {
            relatives[file] = path;
          }
        }
      }
    } else if (type === 'docker') {
      files = await getDockerFiles(paths[0], nowConfig, opts);
    }

    const uploadStamp = stamp();

    if (isBuilds) {
      let buildSpinner = null
      let deploySpinner = null

      for await(const event of createDeployment(paths[0], requestBody)) {
        if (event.type === 'hashes-calculated') {
          hashes = event.payload
        }

        if (event.type === 'file-uploaded') {
          debug(`Uploaded: ${event.payload.file.names.join(' ')} (${bytes(event.payload.file.data.length)})`);
        }

        if (event.type === 'all-files-uploaded') {
          if (!quiet) {
            log(
              `Synced ${event.payload.size} ${uploadStamp()}`
            );
          }
        }

        if (event.type === 'build-state-changed') {
          if (buildSpinner === null) {
            buildSpinner = wait('Building...');
          }
        }

        if (event.type === 'all-builds-completed') {
          buildSpinner()
          deploySpinner = wait('Finalizing...')
        }

        // Handle error events
        if (event.type === 'error') {
          throw await this.handleDeploymentError(event.payload, { hashes, env })
        }

        // Handle ready event
        if (event.type === 'ready') {
          deployment = event.payload
          deploySpinner()
        }
      }
    } else {
      // Read `registry.npmjs.org` authToken from .npmrc
      let authToken;

      if (type === 'npm' && forwardNpm) {
        authToken =
          (await readAuthToken(paths[0])) || (await readAuthToken(homedir()));
      }

      requestBody = {
        token: this._token,
        teamId: this.currentTeam,
        env,
        build,
        meta,
        public: wantsPublic || nowConfig.public,
        forceNew,
        name,
        project,
        description,
        deploymentType: type,
        registryAuthToken: authToken,
        engines,
        scale,
        sessionAffinity,
        limits: nowConfig.limits,
        atlas
      }

      for await(const event of createLegacyDeployment(paths[0], requestBody)) {
        if (event.type === 'hashes-calculated') {
          hashes = event.payload
        }

        if (event.type === 'file-uploaded') {
          debug(`Uploaded: ${event.payload.file.names.join(' ')} (${bytes(event.payload.file.data.length)})`);
        }

        if (event.type === 'all-files-uploaded') {
          if (!quiet) {
            log(
              `Synced ${event.payload.size} ${uploadStamp()}`
            );
          }

          log('Building…');
        }

        // Handle error events
        if (event.type === 'error') {
          throw await this.handleDeploymentError(event.payload, { hashes, env })
        }

        // Handle ready event
        if (event.type === 'ready') {
          log(`Build completed`);
          deployment = event.payload
        }
      }
    }

    // We report about files whose sizes are too big
    let missingVersion = false;

    if (deployment && deployment.warnings) {
      let sizeExceeded = 0;

      deployment.warnings.forEach(warning => {
        if (warning.reason === 'size_limit_exceeded') {
          const { sha, limit } = warning;
          const n = hashes[sha].names.pop();

          warn(`Skipping file ${n} (size exceeded ${bytes(limit)}`);

          hashes[sha].names.unshift(n); // Move name (hack, if duplicate matches we report them in order)
          sizeExceeded++;
        } else if (warning.reason === 'node_version_not_found') {
          warn(`Requested node version ${warning.wanted} is not available`);
          missingVersion = true;
        }
      });

      if (sizeExceeded > 0) {
        warn(`${sizeExceeded} of the files exceeded the limit for your plan.`);
        log(
          `Please upgrade your plan here: ${chalk.cyan(
            'https://zeit.co/account/plan'
          )}`
        );
      }
    }

    if (!isBuilds && !quiet && type === 'npm' && deployment.nodeVersion) {
      if (engines && engines.node && !missingVersion) {
        log(
          chalk`Using Node.js {bold ${
            deployment.nodeVersion
          }} (requested: {dim \`${engines.node}\`})`
        );
      } else {
        log(chalk`Using Node.js {bold ${deployment.nodeVersion}} (default)`);
      }
    }

    this._id = deployment.deploymentId;
    this._host = deployment.url;
    this._missing = [];
    this._fileCount = files.length;

    return deployment;
  }

  async handleDeploymentError(error, { hashes, env }) {
    if (error.status === 429) {
      if (error.code === 'builds_rate_limited') {
        const err = new Error(error.message);
        err.status = error.status;
        err.retryAfter = 'never';
        err.code = error.code;

        return err
      }

      let msg = 'You have been creating deployments at a very fast pace. ';

      if (error.limit && error.limit.reset) {
        const { reset } = error.limit;
        const difference = reset * 1000 - Date.now();

        msg += `Please retry in ${ms(difference, { long: true })}.`;
      } else {
        msg += 'Please slow down.';
      }

      const err = new Error(msg);

      err.status = error.status;
      err.retryAfter = 'never';

      return err
    }

    // If the deployment domain is missing a cert, bail with the error
    if (error.status === 400 && error.code === 'cert_missing'
    ) {
      return responseError(error, null, error);
    }

    if (error.status === 400 && error.code === 'missing_files') {
      this._missing = error.missing || [];
      this._fileCount = hashes.length;

      return error;
    }

    if (error.status === 404 && error.code === 'not_found') {
      return error;
    }

    if (error.status >= 400 && error.status < 500) {
      const err = new Error();

      const { code, unreferencedBuildSpecs } = error;

      if (code === 'env_value_invalid_type') {
        const { key } = error;
        err.message =
          `The env key ${key} has an invalid type: ${typeof env[key]}. ` +
          'Please supply a String or a Number (https://err.sh/now-cli/env-value-invalid-type)';
      } else if (code === 'unreferenced_build_specifications') {
        const count = unreferencedBuildSpecs.length;
        const prefix = count === 1 ? 'build' : 'builds';

        err.message =
          `You defined ${count} ${prefix} that did not match any source files (please ensure they are NOT defined in ${highlight(
            '.nowignore'
          )}):` +
          `\n- ${unreferencedBuildSpecs
            .map(item => JSON.stringify(item))
            .join('\n- ')}`;
      } else {
        Object.assign(err, error);
      }

      return err
    }

    return new Error(error.message);
  }

  async listSecrets() {
    const { secrets } = await this.retry(async bail => {
      const res = await this._fetch('/now/secrets');

      if (res.status === 200) {
        // What we want
        return res.json();
      }
      if (res.status > 200 && res.status < 500) {
        // If something is wrong with our request, we don't retry
        return bail(await responseError(res, 'Failed to list secrets'));
      }
      // If something is wrong with the server, we retry
      throw await responseError(res, 'Failed to list secrets');
    });

    return secrets;
  }

  async list(app, { version = 4, meta = {} } = {}) {
    const fetchRetry = async (url, options = {}) => {
      return this.retry(
        async bail => {
          const res = await this._fetch(url, options);

          if (res.status === 200) {
            return res.json();
          }

          if (res.status > 200 && res.status < 500) {
            // If something is wrong with our request, we don't retry
            return bail(await responseError(res, 'Failed to list deployments'));
          }

          // If something is wrong with the server, we retry
          throw await responseError(res, 'Failed to list deployments');
        },
        {
          retries: 3,
          minTimeout: 2500,
          onRetry: this._onRetry
        }
      );
    };

    if (!app && !Object.keys(meta).length) {
      // Get the 35 latest projects and their latest deployment
      const query = new URLSearchParams({ limit: 35 });
      const projects = await fetchRetry(`/projects/list?${query}`);

      const deployments = await Promise.all(
        projects.map(async ({ id: projectId }) => {
          const query = new URLSearchParams({ limit: 1, projectId });
          const { deployments } = await fetchRetry(
            `/v${version}/now/deployments?${query}`
          );
          return deployments[0];
        })
      );

      return deployments.filter(x => x);
    }

    const query = new URLSearchParams();

    if (app) {
      query.set('app', app);
    }

    Object.keys(meta).map(key => query.set(`meta-${key}`, meta[key]));

    const { deployments } = await fetchRetry(
      `/v${version}/now/deployments?${query}`
    );
    return deployments;
  }

  async listInstances(deploymentId) {
    const { instances } = await this.retry(
      async bail => {
        const res = await this._fetch(
          `/now/deployments/${deploymentId}/instances`
        );

        if (res.status === 200) {
          // What we want
          return res.json();
        }
        if (res.status > 200 && res.status < 500) {
          // If something is wrong with our request, we don't retry
          return bail(await responseError(res, 'Failed to list instances'));
        }
        // If something is wrong with the server, we retry
        throw await responseError(res, 'Failed to list instances');
      },
      {
        retries: 3,
        minTimeout: 2500,
        onRetry: this._onRetry
      }
    );

    return instances;
  }

  async findDeployment(hostOrId) {
    const { debug } = this._output;

    let id = hostOrId && !hostOrId.includes('.');
    let isBuilds = null;

    if (!id) {
      let host = hostOrId.replace(/^https:\/\//i, '');

      if (host.slice(-1) === '/') {
        host = host.slice(0, -1);
      }

      const url = `/v3/now/hosts/${encodeURIComponent(
        host
      )}?resolve=1&noState=1`;

      const { deployment } = await this.retry(
        async bail => {
          const res = await this._fetch(url);

          // No retry on 4xx
          if (res.status >= 400 && res.status < 500) {
            debug(`Bailing on getting a deployment due to ${res.status}`);
            return bail(
              await responseError(res, `Failed to resolve deployment "${id}"`)
            );
          }

          if (res.status !== 200) {
            throw new Error('Fetching a deployment failed');
          }

          return res.json();
        },
        { retries: 3, minTimeout: 2500, onRetry: this._onRetry }
      );

      id = deployment.id;
      isBuilds = deployment.type === 'LAMBDAS';
    }

    const url = `/${
      isBuilds ? 'v9' : 'v5'
    }/now/deployments/${encodeURIComponent(id)}`;

    return this.retry(
      async bail => {
        const res = await this._fetch(url);

        // No retry on 4xx
        if (res.status >= 400 && res.status < 500) {
          debug(`Bailing on getting a deployment due to ${res.status}`);
          return bail(
            await responseError(res, `Failed to resolve deployment "${id}"`)
          );
        }

        if (res.status !== 200) {
          throw new Error('Fetching a deployment failed');
        }

        return res.json();
      },
      { retries: 3, minTimeout: 2500, onRetry: this._onRetry }
    );
  }

  async remove(deploymentId, { hard }) {
    const url = `/now/deployments/${deploymentId}?hard=${hard ? 1 : 0}`;

    await this.retry(async bail => {
      const res = await this._fetch(url, {
        method: 'DELETE'
      });

      if (res.status === 200) {
        // What we want
      } else if (res.status > 200 && res.status < 500) {
        // If something is wrong with our request, we don't retry
        return bail(await responseError(res, 'Failed to remove deployment'));
      } else {
        // If something is wrong with the server, we retry
        throw await responseError(res, 'Failed to remove deployment');
      }
    });

    return true;
  }

  retry(fn, { retries = 3, maxTimeout = Infinity } = {}) {
    return retry(fn, {
      retries,
      maxTimeout,
      onRetry: this._onRetry
    });
  }

  _onRetry(err) {
    this._output.debug(`Retrying: ${err}\n${err.stack}`);
  }

  close() {
    this._agent.close();
  }

  get id() {
    return this._id;
  }

  get url() {
    return `https://${this._host}`;
  }

  get fileCount() {
    return this._fileCount;
  }

  get host() {
    return this._host;
  }

  get syncAmount() {
    if (!this._syncAmount) {
      this._syncAmount = this._missing
        .map(sha => this._files.get(sha).data.length)
        .reduce((a, b) => a + b, 0);
    }

    return this._syncAmount;
  }

  get syncFileCount() {
    return this._missing.length;
  }

  _fetch(_url, opts = {}) {
    if (opts.useCurrentTeam !== false && this.currentTeam) {
      const parsedUrl = parseUrl(_url, true);
      const query = parsedUrl.query;

      query.teamId = this.currentTeam;
      _url = `${parsedUrl.pathname}?${qs.encode(query)}`;
      delete opts.useCurrentTeam;
    }

    opts.headers = opts.headers || {};
    opts.headers.accept = 'application/json';
    opts.headers.authorization = `Bearer ${this._token}`;
    opts.headers['user-agent'] = ua;

    return this._output.time(
      `${opts.method || 'GET'} ${this._apiUrl}${_url} ${JSON.stringify(
        opts.body
      ) || ''}`,
      this._agent.fetch(_url, opts)
    );
  }

  // public retry with built-in retrying that can be
  // used from external utilities. it optioanlly
  // receives a `retry` object in the opts that is
  // passed to the retry utility
  // it accepts a `json` option, which defaults to `true`
  // which automatically returns the json response body
  // if the response is ok and content-type json
  // it does the same for JSON` body` in opts
  async fetch(url, opts = {}) {
    return this.retry(async bail => {
      if (opts.json !== false && opts.body && typeof opts.body === 'object') {
        opts = Object.assign({}, opts, {
          body: JSON.stringify(opts.body),
          headers: Object.assign({}, opts.headers, {
            'Content-Type': 'application/json'
          })
        });
      }
      const res = await this._fetch(url, opts);
      if (res.ok) {
        if (opts.json === false) {
          return res;
        }

        if (!res.headers.get('content-type')) {
          return null;
        }

        return res.headers.get('content-type').includes('application/json')
          ? res.json()
          : res;
      }
      const err = await responseError(res);
      if (res.status >= 400 && res.status < 500) {
        return bail(err);
      }
      throw err;
    }, opts.retry);
  }

  async getPlanMax() {
    return 10;
  }
}

function toRelative(path, base) {
  const fullBase = base.endsWith(SEP) ? base : base + SEP;
  let relative = path.substr(fullBase.length);

  if (relative.startsWith(SEP)) {
    relative = relative.substr(1);
  }

  return relative.replace(/\\/g, '/');
}

function hasNpmStart(pkg) {
  return pkg.scripts && (pkg.scripts.start || pkg.scripts['now-start']);
}

function hasFile(base, files, name) {
  const relative = files.map(file => toRelative(file, base));
  return relative.indexOf(name) !== -1;
}

async function readAuthToken(path, name = '.npmrc') {
  try {
    const contents = await fs.readFile(resolvePath(path, name), 'utf8');
    const npmrc = parseIni(contents);
    return npmrc['//registry.npmjs.org/:_authToken'];
  } catch (err) {
    // Do nothing
  }
}