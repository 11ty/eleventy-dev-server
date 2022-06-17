const chokidar = require("chokidar");
const fs = require("fs");

const pkg = require("./package.json");
const EleventyDevServer = require("./server");

const Logger = {
  info: function(...args) {
    console.log( "[11ty/eleventy-dev-server]", ...args );
  },
  error: function(...args) {
    console.error( "[11ty/eleventy-dev-server]", ...args );
  },
  fatal: function(...args) {
    Logger.error(...args);
    process.exitCode = 1;
  }
};

class Cli {
  static getVersion() {
    return pkg.version;
  }

  static getHelp() {
    return `Usage:

       eleventy-dev-server
       eleventy-dev-server --input=_site
       eleventy-dev-server --port=3000

Arguments:

     --version

     --input=.
       Directory to serve (default: \`.\`)

     --port=8080
       Run the --serve web server on this port (default: \`8080\`)
       Will autoincrement if already in use.

     --domdiff          (enabled)
     --domdiff=true     (enabled)
     --domdiff=false    (disabled)
       Apply HTML changes without a full page reload. (default: \`true\`)

     --help`;
  }

  static getDefaultOptions() {
    return {
      port: "8080",
      input: ".",
      domdiff: true,
    }
  }

  async serve(options = {}) {
    this.options = Object.assign(Cli.getDefaultOptions(), options);

    this.server = EleventyDevServer.getServer("eleventy-dev-server-cli", this.options.input, {
      // TODO allow server configuration extensions
      showVersion: true,
      logger: Logger,
      domdiff: this.options.domdiff,
    });

    this.server.serve(this.options.port);

    this.watcher = chokidar.watch( this.options.input, {
      ignored: ["**/node_modules/**", ".git"],
      // TODO allow chokidar configuration extensions
      ignoreInitial: true,
      // same values as Eleventy
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 25,
      },
    });

    this.watcher.on("change", (path) => {
      Logger.info( "File modified:", path );
      this.reload(path);
    });
    
    this.watcher.on("add", (path) => {
      Logger.info( "File added:", path );
      this.reload(path);
    });

    // TODO? send any errors here to the server too
    // with server.sendError({ error });
  }

  // reverse of server.js->mapUrlToFilePath
  // /resource/ <= /resource/index.html
  // /resource <= resource.html
  getUrlsFromFilePath(path) {
    if(this.options.input) {
      if(this.options.input === ".") {
        path = `/${path}`
      } else {
        path = path.slice(this.options.input.length);
      }
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
    let urls = this.getUrlsFromFilePath(path);
    let obj = {
      inputPath: path,
      content: fs.readFileSync(path, "utf8"),
    }
    return urls.map(url => {
      return Object.assign({ url }, obj);
    });
  }

  reload(path) {
    if(!this.server) {
      return;
    }

    this.server.reload({
      files: [path],
      subtype: path && path.endsWith(".css") ? "css" : undefined,
      build: {
        templates: this.getBuildTemplatesFromFilePath(path)
      }
    });
  }

  close() {
    if(this.watcher) {
      this.watcher.close();
    }
    if(this.server) {
      this.server.close();
    }
  }
}

module.exports = {
  Logger,
  Cli
}