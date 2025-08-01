import { createRequire } from "node:module";
import EleventyDevServer from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

export const Logger = {
  info(...args) {
    console.log( "[11ty/eleventy-dev-server]", ...args );
  },
  error(...args) {
    console.error( "[11ty/eleventy-dev-server]", ...args );
  },
  fatal(...args) {
    Logger.error(...args);
    process.exitCode = 1;
  },
  log(...args) {
    return Logger.info(...args);
  }
};

export class Cli {
  static getVersion() {
    return pkg.version;
  }

  static getHelp() {
    return `Usage:

       eleventy-dev-server
       eleventy-dev-server --dir=_site
       eleventy-dev-server --port=3000

Arguments:

     --version

     --dir=.
       Directory to serve (default: \`.\`)

     --input (alias for --dir)

     --port=8080
       Run the web server on this port (default: \`8080\`)
       Will autoincrement if already in use.

     --domdiff          (enabled, default)
     --domdiff=false    (disabled)
       Apply HTML changes without a full page reload.

     --help`;
  }

  static getDefaultOptions() {
    return {
      port: "8080",
      input: ".",
      domDiff: true,
    }
  }

  async serve(options = {}) {
    this.options = Object.assign(Cli.getDefaultOptions(), options);

    this.server = EleventyDevServer.getServer("eleventy-dev-server-cli", this.options.input, {
      // TODO allow server configuration extensions
      showVersion: true,
      logger: Logger,
      domDiff: this.options.domDiff,

      // CLI watches all files in the folder by default
      // this is different from Eleventy usage!
      watch: [ this.options.input ],
    });

    this.server.serve(this.options.port);

    // TODO? send any errors here to the server too
    // with server.sendError({ error });
  }

  close() {
    if(this.server) {
      return this.server.close();
    }
  }
}
