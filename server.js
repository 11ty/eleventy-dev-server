const pkg = require("./package.json");
const path = require("path");
const fs = require("fs");
const finalhandler = require("finalhandler");
const { WebSocketServer } = require("ws");
const mime = require("mime");
const ssri = require("ssri");
const devip = require("dev-ip");
const { TemplatePath } = require("@11ty/eleventy-utils");

const debug = require("debug")("EleventyDevServer");

const wrapResponse = require("./server/wrapResponse.js");

const serverCache = {};
const DEFAULT_OPTIONS = {
  port: 8080,
  enabled: true,        // Enable live reload at all
  showAllHosts: false,  // IP address based hosts (other than localhost)
  folder: ".11ty",      // Change the name of the special folder used for injected scripts
  portReassignmentRetryCount: 10, // number of times to increment the port if in use
  https: {},            // `key` and `cert`, required for http/2 and https
  domdiff: true,        // Use morphdom to apply DOM diffing delta updates to HTML
  showVersion: false,   // Whether or not to show the server version on the command line.
  encoding: "utf-8",    // Default file encoding

  pathPrefix: "/",      // May be overridden by Eleventy, adds a virtual base directory to your project

  // Logger (fancier one is injected by Eleventy)
  logger: {
    info: console.log,
    error: console.error,
  }
}

class EleventyDevServer {
  static getServer(...args) {
    let [name] = args;

    // TODO what if previously cached server has new/different dir or options
    if (!serverCache[name]) {
      serverCache[name] = new EleventyDevServer(...args);
    }

    return serverCache[name];
  }

  constructor(name, dir, options = {}) {
    this.name = name;
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
    this.fileCache = {};
    // Directory to serve
    if(!dir) {
      throw new Error("Missing `dir` to serve.");
    }
    this.dir = dir;
    this.logger = this.options.logger;
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

    // Check that the file is in the output path (error if folks try use `..` in the filepath)
    let absComputedPath = TemplatePath.absolutePath(computedPath);
    let absOutputDir = TemplatePath.absolutePath(computedPath);
    if (!absComputedPath.startsWith(absOutputDir)) {
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
      if (!url.startsWith(this.options.pathPrefix)) {
        return {
          statusCode: 404,
        };
      }

      url = url.substr(this.options.pathPrefix.length);
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

    // /resource/ => reidrect to /resource
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
    let script = `<script type="module" integrity="${integrityHash}"${inlineContents ? `>${scriptContents}` : ` src="/${this.options.folder}/reload-client.js">`}</script>`;

    // <title> is the only *required* element in an HTML document
    if (content.includes("</title>")) {
      return content.replace("</title>", `</title>${script}`);
    }

    // If you’ve reached this section, your HTML is invalid!
    // We want to be super forgiving here, because folks might be in-progress editing the document!
    if (content.includes("</head>")) {
      return content.replace("</head>", `${script}</head>`);
    }
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

  renderFile(filepath, res) {
    let contents = fs.readFileSync(filepath);
    let mimeType = mime.getType(filepath);

    if (mimeType === "text/html") {
      res.setHeader("Content-Type", `text/html; charset=${this.options.encoding}`);
      // the string is important here, wrapResponse expects strings internally for HTML content (for now)
      return res.end(contents.toString());
    }

    if (mimeType) {
      res.setHeader("Content-Type", mimeType);
    }

    return res.end(contents);
  }

  eleventyFolderMiddleware(req, res, next) {
    if(req.url === `/${this.options.folder}/reload-client.js`) {
      if(this.options.enabled) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this._getFileContents("./client/reload-client.js"));
      }
    } else if(req.url === `/${this.options.folder}/morphdom.js`) {
      if(this.options.domdiff) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this._getFileContents("./node_modules/morphdom/dist/morphdom-esm.js", path.resolve(".")));
      }
    }

    next();
  }

  requestMiddleware(req, res) {
    // Known issue with `finalhandler` and HTTP/2:
    // UnsupportedWarning: Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)
    // https://github.com/pillarjs/finalhandler/pull/34

    let next = finalhandler(req, res, {
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

    let match = this.mapUrlToFilePath(req.url);
    // console.log( req.url, match );
    debug( req.url, match );

    if (match) {
      if (match.statusCode === 200 && match.filepath) {
        return this.renderFile(match.filepath, res);
      }

      let raw404Path = this.getOutputDirFilePath("404.html");
      if(match.statusCode === 404 && this.isOutputFilePathExists(raw404Path)) {
        res.statusCode = match.statusCode;
        return this.renderFile(raw404Path, res);
      }

      // Redirects
      if (match.url) {
        res.statusCode = match.statusCode;
        res.setHeader("Location", match.url);
        return res.end();
      }

    }

    next();
  }

  async onRequestHandler (req, res) {
    res = wrapResponse(res, content => {
      if(this.options.enabled !== false) {
        let scriptContents = this._getFileContents("./client/reload-client.js");
        let integrityHash = ssri.fromData(scriptContents);

        // finalhandler error pages have a Content-Security-Policy that prevented the client script from executing
        if(res.statusCode !== 200) {
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
    middlewares.push(this.requestMiddleware);
    middlewares.reverse();

    middlewares.push(this.eleventyFolderMiddleware);

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

      this.logger.info(`Server at ${hostsStr}${this._serverProtocol}//localhost:${port}${this.options.pathPrefix}${this.options.showVersion ? ` (v${pkg.version})` : ""}`);
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
      server: this.server,
    });

    updateServer.on("connection", (ws) => {
      this.updateNotifier = ws;

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

  sendUpdateNotification(obj) {
    if (this.updateNotifier) {
      this.updateNotifier.send(JSON.stringify(obj));
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
  }

  sendError({ error }) {
    this.sendUpdateNotification({
      type: "eleventy.error",
      // Thanks https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
      error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
  }

  reload(event) {
    let { subtype, files, build } = event;
    if (build.templates) {
      build.templates = build.templates
        .filter(entry => {
          if(!this.options.domdiff) {
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
