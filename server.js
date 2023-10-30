const pkg = require("./package.json");
const path = require("path");
const fs = require("fs");
const finalhandler = require("finalhandler");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const mime = require("mime");
const ssri = require("ssri");
const devip = require("dev-ip");
const chokidar = require("chokidar");
const { TemplatePath } = require("@11ty/eleventy-utils");

const debug = require("debug")("EleventyDevServer");

const wrapResponse = require("./server/wrapResponse.js");

const DEFAULT_OPTIONS = {
  port: 8080,
  liveReload: true,     // Enable live reload at all
  showAllHosts: false,  // IP address based hosts (other than localhost)
  injectedScriptsFolder: ".11ty", // Change the name of the special folder used for injected scripts
  portReassignmentRetryCount: 10, // number of times to increment the port if in use
  https: {},            // `key` and `cert`, required for http/2 and https
  domDiff: true,        // Use morphdom to apply DOM diffing delta updates to HTML
  showVersion: false,   // Whether or not to show the server version on the command line.
  encoding: "utf-8",    // Default file encoding
  pathPrefix: "/",      // May be overridden by Eleventy, adds a virtual base directory to your project
  watch: [],            // Globs to pass to separate dev server chokidar for watching
  aliases: {},          // Aliasing feature
  rebuildUrl: null,     // POST URL to trigger rebuild
  rebuildUrlToken: "",  // Secret token in x-11ty-rebuild-token header

  // Logger (fancier one is injected by Eleventy)
  logger: {
    info: console.log,
    log: console.log,
    error: console.error,
  }
}

class EleventyDevServer {
  static getServer(...args) {
    return new EleventyDevServer(...args);
  }

  constructor(name, dir, options = {}) {
    debug("Creating new Dev Server instance.");
    this.name = name;
    this.normalizeOptions(options);

    this.fileCache = {};
    // Directory to serve
    if(!dir) {
      throw new Error("Missing `dir` to serve.");
    }
    this.dir = dir;
    this.logger = this.options.logger;

    if(this.options.watch.length > 0) {
      this.getWatcher();
    }
  }

  normalizeOptions(options = {}) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);

    // better names for options https://github.com/11ty/eleventy-dev-server/issues/41
    if(options.folder !== undefined) {
      this.options.injectedScriptsFolder = options.folder;
      delete this.options.folder;
    }
    if(options.domdiff !== undefined) {
      this.options.domDiff = options.domdiff;
      delete this.options.domdiff;
    }
    if(options.enabled !== undefined) {
      this.options.liveReload = options.enabled;
      delete this.options.enabled;
    }

    this.options.pathPrefix = this.cleanupPathPrefix(this.options.pathPrefix);
  }

  setEventBus(_eventBus) {
    this.eventBus = _eventBus;
  }

  get watcher() {
    if(!this._watcher) {
      debug("Watching %O", this.options.watch);
      // TODO if using Eleventy and `watch` option includes output folder (_site) this will trigger two update events!
      this._watcher = chokidar.watch(this.options.watch, {
        // TODO allow chokidar configuration extensions (or re-use the ones in Eleventy)

        ignored: ["**/node_modules/**", ".git"],
        ignoreInitial: true,

        // same values as Eleventy
        awaitWriteFinish: {
          stabilityThreshold: 150,
          pollInterval: 25,
        },
      });

      this._watcher.on("change", (path) => {
        this.logger.log( `File changed: ${path} (skips build)` );
        this.reloadFiles([path]);
      });

      this._watcher.on("add", (path) => {
        this.logger.log( `File added: ${path} (skips build)` );
        this.reloadFiles([path]);
      });
    }

    return this._watcher;
  }

  getWatcher() {
    return this.watcher;
  }

  watchFiles(files) {
    if(Array.isArray(files)) {
      files = files.map(entry => TemplatePath.stripLeadingDotSlash(entry));

      debug("Also watching %O", files);
      this.watcher.add(files);
    }
  }

  cleanupPathPrefix(pathPrefix) {
    if(!pathPrefix || pathPrefix === "/") {
      return "/";
    }
    if(!pathPrefix.startsWith("/")) {
      pathPrefix = `/${pathPrefix}`
    }
    if(!pathPrefix.endsWith("/")) {
      pathPrefix = `${pathPrefix}/`;
    }
    return pathPrefix;
  }

  // Allowed list of files that can be served from outside `dir`
  setAliases(aliases) {
    if(aliases) {
      this.passthroughAliases = aliases;
      debug( "Setting aliases (emulated passthrough copy) %O", aliases );
    }
  }

  matchPassthroughAlias(url) {
    let aliases = Object.assign({}, this.options.aliases, this.passthroughAliases);
    for(let targetUrl in aliases) {
      if(!targetUrl) {
        continue;
      }

      let file = aliases[targetUrl];
      if(url.startsWith(targetUrl)) {
        let inputDirectoryPath = file + url.slice(targetUrl.length);

        // e.g. addPassthroughCopy("img/") but <img src="/img/built/IdthKOzqFA-350.png">
        // generated by the image plugin (written to the output folder)
        // If they do not exist in the input directory, this will fallback to the output directory.
        if(fs.existsSync(inputDirectoryPath)) {
          return inputDirectoryPath;
        }
      }
    }
    return false;
  }

  isFileInDirectory(dir, file) {
    let absoluteDir = TemplatePath.absolutePath(dir);
    let absoluteFile = TemplatePath.absolutePath(file);
    return absoluteFile.startsWith(absoluteDir);
  }

  getOutputDirFilePath(filepath, filename = "") {
    let computedPath;
    if(filename === ".html") {
      // avoid trailing slash for filepath/.html requests
      let prefix = path.join(this.dir, filepath);
      if(prefix.endsWith(path.sep)) {
        prefix = prefix.substring(0, prefix.length - path.sep.length);
      }
      computedPath = prefix + filename;
    } else {
      computedPath = path.join(this.dir, filepath, filename);
    }

    computedPath = decodeURIComponent(computedPath);

    if(!filename) { // is a direct URL request (not an implicit .html or index.html add)
      let alias = this.matchPassthroughAlias(filepath);

      if(alias) {
        if(!this.isFileInDirectory(path.resolve("."), alias)) {
          throw new Error("Invalid path");
        }

        return alias;
      }
    }

    // Check that the file is in the output path (error if folks try use `..` in the filepath)
    if(!this.isFileInDirectory(this.dir, computedPath)) {
      throw new Error("Invalid path");
    }

    return computedPath;
  }

  isOutputFilePathExists(rawPath) {
    return fs.existsSync(rawPath) && !TemplatePath.isDirectorySync(rawPath);
  }

  /* Use conventions documented here https://www.zachleat.com/web/trailing-slash/
   * resource.html exists:
   *    /resource matches
   *    /resource/ redirects to /resource
   * resource/index.html exists:
   *    /resource redirects to /resource/
   *    /resource/ matches
   * both resource.html and resource/index.html exists:
   *    /resource matches /resource.html
   *    /resource/ matches /resource/index.html
   */
  mapUrlToFilePath(url) {
    // Note: `localhost` is not important here, any host would work
    let u = new URL(url, "http://localhost/");
    url = u.pathname;

    // Remove PathPrefix from start of URL
    if (this.options.pathPrefix !== "/") {
      // Requests to root should redirect to new pathPrefix
      if(url === "/") {
        return {
          statusCode: 302,
          url: this.options.pathPrefix,
        }
      }

      // Requests to anything outside of root should fail with 404
      if (!url.startsWith(this.options.pathPrefix)) {
        return {
          statusCode: 404,
        };
      }

      url = url.slice(this.options.pathPrefix.length - 1);
    }

    let rawPath = this.getOutputDirFilePath(url);
    if (this.isOutputFilePathExists(rawPath)) {
      return {
        statusCode: 200,
        filepath: rawPath,
      };
    }

    let indexHtmlPath = this.getOutputDirFilePath(url, "index.html");
    let indexHtmlExists = fs.existsSync(indexHtmlPath);

    let htmlPath = this.getOutputDirFilePath(url, ".html");
    let htmlExists = fs.existsSync(htmlPath);

    // /resource/ => /resource/index.html
    if (indexHtmlExists && url.endsWith("/")) {
      return {
        statusCode: 200,
        filepath: indexHtmlPath,
      };
    }
    // /resource => resource.html
    if (htmlExists && !url.endsWith("/")) {
      return {
        statusCode: 200,
        filepath: htmlPath,
      };
    }

    // /resource => redirect to /resource/
    if (indexHtmlExists && !url.endsWith("/")) {
      return {
        statusCode: 301,
        url: url + "/",
      };
    }

    // /resource/ => redirect to /resource
    if (htmlExists && url.endsWith("/")) {
      return {
        statusCode: 301,
        url: url.substring(0, url.length - 1),
      };
    }

    return {
      statusCode: 404,
    };
  }

  _getFileContents(localpath, rootDir, useCache = true) {
    if(this.fileCache[localpath]) {
      return this.fileCache[localpath];
    }

    let filepath;
    let searchLocations = [];

    if(rootDir) {
      searchLocations.push(TemplatePath.absolutePath(rootDir, localpath));
    }
    // fallbacks for file:../ installations
    searchLocations.push(TemplatePath.absolutePath(__dirname, localpath));
    searchLocations.push(TemplatePath.absolutePath(__dirname, "../../../", localpath));

    for(let loc of searchLocations) {
      if(fs.existsSync(loc)) {
        filepath = loc;
        break;
      }
    }

    let contents = fs.readFileSync(filepath, {
      encoding: this.options.encoding,
    });
    if(useCache) {
      this.fileCache[localpath] = contents;
    }
    return contents;
  }

  augmentContentWithNotifier(content, inlineContents = false, options = {}) {
    let { integrityHash, scriptContents } = options;
    if(!scriptContents) {
      scriptContents = this._getFileContents("./client/reload-client.js");
    }
    if(!integrityHash) {
      integrityHash = ssri.fromData(scriptContents);
    }

    // This isn’t super necessary because it’s a local file, but it’s included anyway
    let script = `<script type="module" integrity="${integrityHash}"${inlineContents ? `>${scriptContents}` : ` src="/${this.options.injectedScriptsFolder}/reload-client.js">`}</script>`;

    if (content.includes("</head>")) {
      return content.replace("</head>", `${script}</head>`);
    }

    // If the HTML document contains an importmap, insert the module script after the importmap element
    let importMapRegEx = /<script type=\\?importmap\\?[^>]*>(\n|.)*?<\/script>/gmi;
    let importMapMatch = content.match(importMapRegEx)?.[0];

    if (importMapMatch) {
      return content.replace(importMapMatch, `${importMapMatch}${script}`);
    }

    // <title> is the only *required* element in an HTML document
    if (content.includes("</title>")) {
      return content.replace("</title>", `</title>${script}`);
    }

    // If you’ve reached this section, your HTML is invalid!
    // We want to be super forgiving here, because folks might be in-progress editing the document!
    if (content.includes("</body>")) {
      return content.replace("</body>", `${script}</body>`);
    }
    if (content.includes("</html>")) {
      return content.replace("</html>", `${script}</html>`);
    }
    if (content.includes("<!doctype html>")) {
      return content.replace("<!doctype html>", `<!doctype html>${script}`);
    }

    // Notably, works without content at all!!
    return (content || "") + script;
  }

  getFileContentType(filepath, res) {
    let contentType = res.getHeader("Content-Type");

    // Content-Type might be already set via middleware
    if (contentType) {
      return contentType;
    }

    let mimeType = mime.getType(filepath);
    if (!mimeType) {
      return;
    }

    contentType = mimeType;

    // We only want to append charset if the header is not already set
    if (contentType === "text/html") {
      contentType = `text/html; charset=${this.options.encoding}`;
    }

    return contentType;
  }

  renderFile(filepath, res) {
    let contents = fs.readFileSync(filepath);
    let contentType = this.getFileContentType(filepath, res);

    if (!contentType) {
      return res.end(contents);
    }

    res.setHeader("Content-Type", contentType);

    if (contentType.startsWith("text/html")) {
      // the string is important here, wrapResponse expects strings internally for HTML content (for now)
      return res.end(contents.toString());
    }

    return res.end(contents);
  }

  eleventyDevServerMiddleware(req, res, next) {
    if (this.options.rebuildUrl && req.url === this.options.rebuildUrl && req.method === 'POST') {
      const token = req.headers['x-11ty-rebuild-token'];
      if (token !== this.options.rebuildUrlToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
      }

      this.eventBus.emit('eleventyDevServer.rebuild');
      res.writeHead(200);
      return res.end();
    }

    if(req.url === `/${this.options.injectedScriptsFolder}/reload-client.js`) {
      if(this.options.liveReload) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this._getFileContents("./client/reload-client.js"));
      }
    } else if(req.url === `/${this.options.injectedScriptsFolder}/morphdom.js`) {
      if(this.options.domDiff) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this._getFileContents("./node_modules/morphdom/dist/morphdom-esm.js", path.resolve(".")));
      }
    }

    next();
  }

  // This runs at the end of the middleware chain
  eleventyProjectMiddleware(req, res) {
    // Known issue with `finalhandler` and HTTP/2:
    // UnsupportedWarning: Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)
    // https://github.com/pillarjs/finalhandler/pull/34

    let lastNext = finalhandler(req, res, {
      onerror: (e) => {
        if (e.statusCode === 404) {
          let localPath = TemplatePath.stripLeadingSubPath(
            e.path,
            TemplatePath.absolutePath(this.dir)
          );
          this.logger.error(
            `HTTP ${e.statusCode}: Template not found in output directory (${this.dir}): ${localPath}`
          );
        } else {
          this.logger.error(`HTTP ${e.statusCode}: ${e.message}`);
        }
      },
    });

    // middleware (maybe a serverless request) already set a body upstream, skip this part
    if(!res._shouldForceEnd) {
      let match = this.mapUrlToFilePath(req.url);
      debug( req.url, match );

      if (match) {
        if (match.statusCode === 200 && match.filepath) {
          return this.renderFile(match.filepath, res);
        }

        // Redirects, usually for trailing slash to .html stuff
        if (match.url) {
          res.statusCode = match.statusCode;
          res.setHeader("Location", match.url);
          return res.end();
        }

        let raw404Path = this.getOutputDirFilePath("404.html");
        if(match.statusCode === 404 && this.isOutputFilePathExists(raw404Path)) {
          res.statusCode = match.statusCode;
          res.isCustomErrorPage = true;
          return this.renderFile(raw404Path, res);
        }
      }
    }

    if(res.body && !res.bodyUsed) {
      if(res._shouldForceEnd) {
        res.end();
      } else {
        let err = new Error("A response was never written to the stream. Are you missing a server middleware with `res.end()`?");
        err.statusCode = 500;
        lastNext(err);
        return;
      }
    }

    lastNext();
  }

  async onRequestHandler (req, res) {
    res = wrapResponse(res, content => {

      // check to see if this is a client fetch and not a navigation
      let isXHR = req.headers["sec-fetch-mode"] && req.headers["sec-fetch-mode"] != "navigate";

      if(this.options.liveReload !== false && !isXHR) {
        let scriptContents = this._getFileContents("./client/reload-client.js");
        let integrityHash = ssri.fromData(scriptContents);

        // Bare (not-custom) finalhandler error pages have a Content-Security-Policy `default-src 'none'` that
        // prevents the client script from executing, so we override it
        if(res.statusCode !== 200 && !res.isCustomErrorPage) {
          res.setHeader("Content-Security-Policy", `script-src '${integrityHash}'`);
        }
        return this.augmentContentWithNotifier(content, res.statusCode !== 200, {
          scriptContents,
          integrityHash
        });
      }

      return content;
    });

    let middlewares = this.options.middleware || [];
    middlewares = middlewares.slice();

    // TODO because this runs at the very end of the middleware chain,
    // if we move the static stuff up in the order we could use middleware to modify
    // the static content in middleware!
    middlewares.push(this.eleventyProjectMiddleware);
    middlewares.reverse();

    // Runs very first in the middleware chain
    middlewares.push(this.eleventyDevServerMiddleware);

    let bound = [];
    let next;

    for(let ware of middlewares) {
      let fn;
      if(next) {
        fn = ware.bind(this, req, res, next);
      } else {
        fn = ware.bind(this, req, res);
      }
      bound.push(fn);
      next = fn;
    }

    bound.reverse();

    let [first] = bound;
    await first();
  }

  get server() {
    if (this._server) {
      return this._server;
    }

    this.start = Date.now();

    // Check for secure server requirements, otherwise use HTTP
    let { key, cert } = this.options.https;
    if(key && cert) {
      const { createSecureServer } = require("http2");

      let options = {
        allowHTTP1: true,

        // Credentials
        key: fs.readFileSync(key),
        cert: fs.readFileSync(cert),
      };
      this._server = createSecureServer(options, this.onRequestHandler.bind(this));
      this._serverProtocol = "https:";
    } else {
      const { createServer } = require("http");

      this._server = createServer(this.onRequestHandler.bind(this));
      this._serverProtocol = "http:";
    }

    this.portRetryCount = 0;
    this._server.on("error", (err) => {
      if (err.code == "EADDRINUSE") {
        if (this.portRetryCount < this.options.portReassignmentRetryCount) {
          this.portRetryCount++;
          debug(
            "Server already using port %o, trying the next port %o. Retry number %o of %o",
            err.port,
            err.port + 1,
            this.portRetryCount,
            this.options.portReassignmentRetryCount
          );
          this._serverListen(err.port + 1);
        } else {
          throw new Error(
            `Tried ${this.options.portReassignmentRetryCount} different ports but they were all in use. You can a different starter port using --port on the command line.`
          );
        }
      } else {
        this._serverErrorHandler(err);
      }
    });

    this._server.on("listening", (e) => {
      this.setupReloadNotifier();

      let { port } = this._server.address();

      let hostsStr = "";
      if(this.options.showAllHosts) {
        // TODO what happens when the cert doesn’t cover non-localhost hosts?
        let hosts = devip().map(host => `${this._serverProtocol}//${host}:${port}${this.options.pathPrefix} or`);
        hostsStr = hosts.join(" ") + " ";
      }

      let startBenchmark = ""; // this.start ? ` ready in ${Date.now() - this.start}ms` : "";
      this.logger.info(`Server at ${hostsStr}${this._serverProtocol}//localhost:${port}${this.options.pathPrefix}${this.options.showVersion ? ` (v${pkg.version})` : ""}${startBenchmark}`);
    });

    return this._server;
  }

  _serverListen(port) {
    this.server.listen({
      port,
    });
  }

  async getPort() {
    return new Promise(resolve => {
      this.server.on("listening", (e) => {
        let { port } = this._server.address();
        resolve(port);
      });
    })
  }

  serve(port) {
    this.getWatcher();

    this._serverListen(port);
  }

  _serverErrorHandler(err) {
    if (err.code == "EADDRINUSE") {
      this.logger.error(`Server error: Port in use ${err.port}`);
    } else {
      this.logger.error(`Server error: ${err.message}`);
    }
  }

  // Websocket Notifications
  setupReloadNotifier() {
    let updateServer = new WebSocketServer({
      // includes the port
      server: this.server,
    });

    updateServer.on("connection", (ws) => {
      this.sendUpdateNotification({
        type: "eleventy.status",
        status: "connected",
      });
    });

    updateServer.on("error", (err) => {
      this._serverErrorHandler(err);
    });

    this.updateServer = updateServer;
  }

  // Broadcasts to all open browser windows
  sendUpdateNotification(obj) {
    if(!this.updateServer?.clients) {
      return;
    }

    for(let client of this.updateServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(obj));
      }
    }
  }

  close() {
    // TODO would be awesome to set a delayed redirect when port changed to redirect to new _server_
    this.sendUpdateNotification({
      type: "eleventy.status",
      status: "disconnected",
    });

    if(this.server) {
      this.server.close();
    }
    if(this.updateServer) {
      this.updateServer.close();
    }
    if(this._watcher) {
      this._watcher.close();
      delete this._watcher;
    }
  }

  sendError({ error }) {
    this.sendUpdateNotification({
      type: "eleventy.error",
      // Thanks https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
      error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
  }

  // reverse of mapUrlToFilePath
  // /resource/ <= /resource/index.html
  // /resource <= resource.html
  getUrlsFromFilePath(path) {
    if(this.dir === ".") {
      path = `/${path}`
    } else {
      path = path.slice(this.dir.length);
    }

    let urls = [];
    urls.push(path);

    if(path.endsWith("/index.html")) {
      urls.push(path.slice(0, -1 * "index.html".length));
    } else if(path.endsWith(".html")) {
      urls.push(path.slice(0, -1 * ".html".length));
    }

    return urls;
  }

  // [{ url, inputPath, content }]
  getBuildTemplatesFromFilePath(path) {
    // We can skip this for non-html files, dom-diffing will not apply
    if(!path.endsWith(".html")) {
      return [];
    }

    let urls = this.getUrlsFromFilePath(path);
    let obj = {
      inputPath: path,
      content: fs.readFileSync(path, "utf8"),
    }

    return urls.map(url => {
      return Object.assign({ url }, obj);
    });
  }

  reloadFiles(files, useDomDiffingForHtml = true) {
    if(!Array.isArray(files)) {
      throw new Error("reloadFiles method requires an array of file paths.");
    }

    let subtype;
    if(!files.some((entry) => !entry.endsWith(".css"))) {
      // all css changes
      subtype = "css";
    }

    let templates = [];
    if(useDomDiffingForHtml && this.options.domDiff) {
      for(let filePath of files) {
        if(!filePath.endsWith(".html")) {
          continue;
        }
        for(let templateEntry of this.getBuildTemplatesFromFilePath(filePath)) {
          templates.push(templateEntry);
        }
      }
    }

    this.reload({
      files,
      subtype,
      build: {
        templates
      }
    });
  }

  reload(event) {
    let { subtype, files, build } = event;
    if (build?.templates) {
      build.templates = build.templates
        .filter(entry => {
          if(!this.options.domDiff) {
            // Don’t include any files if the dom diffing option is disabled
            return false;
          }

          // Filter to only include watched templates that were updated
          return (files || []).includes(entry.inputPath);
        });
    }

    this.sendUpdateNotification({
      type: "eleventy.reload",
      subtype,
      files,
      build,
    });
  }
}

module.exports = EleventyDevServer;
