const path = require("path");
const fs = require("fs");
const finalhandler = require("finalhandler");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const mime = require('mime');
const debug = require("debug")("EleventyServeAdapter");

const MAX_PORT_ASSIGNMENT_RETRIES = 10;
const serverCache = {};

class EleventyServeAdapter {
  static getServer(...args) {
    let [name] = args;

    if (!serverCache[name]) {
      serverCache[name] = new EleventyServeAdapter(...args);
    }

    return serverCache[name];
  }

  constructor(name, deps = {}) {
    this.name = name;
    this.fileCache = {};
    
    let requiredDependencyKeys = ["config", "templatePath", "pathPrefixer", "templatePath"];
    for(let key of requiredDependencyKeys) {
      if(!deps[key]) {
        throw new Error(`Missing injected upstream dependency: ${key}`);
      }
    }
    
    let { logger, templatePath, pathPrefixer, config } = deps;
    this.config = config;
    this.logger = logger;
    this.templatePath = templatePath;
    this.pathPrefixer = pathPrefixer;
  }

  get config() {
    if (!this._config) {
      throw new EleventyServeConfigError(
        "You need to set the config property on EleventyServeAdapter."
      );
    }

    return this._config;
  }

  set config(config) {
    this._config = config;
  }

  getOutputDirFilePath(filepath, filename = "") {
    let computedPath;
    if(filename === ".html") {
      // avoid trailing slash on filepath/.html
      computedPath = path.join(this.config.dir.output, filepath) + filename;
    } else {
      computedPath = path.join(this.config.dir.output, filepath, filename);
    }

    // Check that the file is in the output path (error if folks try use `..` in the filepath)
    let absComputedPath = this.templatePath.absolutePath(computedPath);
    let absOutputDir = this.templatePath.absolutePath(computedPath);
    if (!absComputedPath.startsWith(absOutputDir)) {
      throw new Error("Invalid path");
    }

    return computedPath;
  }

  isOutputFilePathExists(rawPath) {
    return fs.existsSync(rawPath) && !this.templatePath.isDirectorySync(rawPath);
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

    let pathPrefix = this.pathPrefixer.normalizePathPrefix(
      this.config.pathPrefix
    );
    if (pathPrefix !== "/") {
      if (!url.startsWith(pathPrefix)) {
        return {
          statusCode: 404,
        };
      }

      url = url.substr(pathPrefix.length);
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
    if (indexHtmlExists) {
      if (url.endsWith("/")) {
        return {
          statusCode: 200,
          filepath: indexHtmlPath,
        };
      }

      return {
        statusCode: 301,
        url: url + "/",
      };
    }

    // /resource => resource.html
    if (htmlExists) {
      if (!url.endsWith("/")) {
        return {
          statusCode: 200,
          filepath: htmlPath,
        };
      }

      return {
        statusCode: 301,
        url: url + "/",
      };
    }

    return {
      statusCode: 404,
    };
  }

  _getFileContents(localpath) {
    if(this.fileCache[localpath]) {
      return this.fileCache[localpath];
    }

    let filepath = this.templatePath.absolutePath(
      __dirname,
      localpath
    );
    return fs.readFileSync(filepath, {
      encoding: "utf8",
    });
  }

  augmentContentWithNotifier(content) {
    let script = `<script type="module" src="/.11ty/reload-client.js"></script>`;

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

  get server() {
    if (this._server) {
      return this._server;
    }

    this._server = createServer((req, res) => {
      let next = finalhandler(req, res, {
        onerror: (e) => {
          if (e.statusCode === 404) {
            let localPath = this.templatePath.stripLeadingSubPath(
              e.path,
              this.templatePath.absolutePath(this.config.dir.output)
            );
            this.logger.error(
              `HTTP ${e.statusCode}: Template not found in output directory (${this.config.dir.output}): ${localPath}`
            );
          } else {
            this.logger.error(`HTTP ${e.statusCode}: ${e.message}`);
          }
        },
      });

      if(req.url === "/.11ty/reload-client.js") {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this._getFileContents("./client/reload-client.js"));
        return;
      } else if(req.url === "/.11ty/morphdom.js") {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this._getFileContents("./node_modules/morphdom/dist/morphdom-esm.js"));
        return;
      }
      
      // TODO add the reload notifier to error pages too!
      let match = this.mapUrlToFilePath(req.url);
      if (match) {
        if (match.statusCode === 200 && match.filepath) {
          let contents = fs.readFileSync(match.filepath);
          let mimeType = mime.getType(match.filepath);
          if (mimeType === "text/html") {
            res.setHeader("Content-Type", mimeType);
            res.end(this.augmentContentWithNotifier(contents.toString()));
            return;
          }
          if (mimeType) {
            res.setHeader("Content-Type", mimeType);
          }
          res.end(contents);
          return;
        }
        // TODO add support for 404 pages (in different Jamstack server configurations)
        if (match.url) {
          res.writeHead(match.statusCode, {
            Location: match.url,
          });
          res.end();
          return;
        }
      }

      next();
    });

    this.portRetryCount = 0;
    this._server.on("error", (err) => {
      if (err.code == "EADDRINUSE") {
        if (this.portRetryCount < MAX_PORT_ASSIGNMENT_RETRIES) {
          this.portRetryCount++;
          debug(
            "Server already using port %o, trying the next port %o. Retry number %o of %o",
            err.port,
            err.port + 1,
            this.portRetryCount,
            MAX_PORT_ASSIGNMENT_RETRIES
          );
          this.serverListen(err.port + 1);
        } else {
          throw new Error(
            `Tried ${MAX_PORT_ASSIGNMENT_RETRIES} different ports but they were all in use. You can a different starter port using --port on the command line.`
          );
        }
      } else {
        this.serverErrorHandler(err);
      }
    });

    this._server.on("listening", (e) => {
      this.setupReloadNotifier();
      let { port } = this._server.address();
      this.logger.message(
        `Server running at http://localhost:${port}/`,
        "log",
        "blue",
        true
      );
    });

    return this._server;
  }

  serverListen(port) {
    this.server.listen({
      port,
    });
  }

  init(options) {
    this.serverListen(options.port);
  }

  serverErrorHandler(err) {
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
      this.serverErrorHandler(err);
    });
  }

  sendUpdateNotification(obj) {
    if (this.updateNotifier) {
      this.updateNotifier.send(JSON.stringify(obj));
    }
  }

  exit() {
    this.sendUpdateNotification({
      type: "eleventy.status",
      status: "disconnected",
    });
  }

  sendError({ error }) {
    this.sendUpdateNotification({
      type: "eleventy.error",
      // Thanks https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
      error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
  }

  // TODO make this smarter, allow clients to subscribe to specific URLs and only send updates for those URLs
  async reload({ subtype, files, build }) {
    let pathprefix = this.pathPrefixer.normalizePathPrefix(
      this.config.pathPrefix
    );
    if (build.templates) {
      build.templates = build.templates
        .filter(entry => !!entry)
        .filter(entry => {
          // Filter to only include watched templates that were updated
          return (files || []).includes(entry.inputPath);
        })
        .map(entry => {
          // Add pathPrefix to all template urls
          entry.url = this.pathPrefixer.joinUrlParts(pathprefix, entry.url);
          return entry;
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
module.exports = EleventyServeAdapter;
